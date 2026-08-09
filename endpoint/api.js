const express = require("express");
const qs = require("qs");
const cloudscraper = require("cloudscraper");
const router = express.Router();

// KONFIGURASI PROV
const PAYINAJA_API_KEY = process.env.PAYINAJA_API_KEY;
const PAYINAJA_BASE_URL = "https://payinaja.com/api/v1";

const {
  validateApiKey,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL, // Tetap dipakai untuk orderan (Atlantic)
  ATLAN_API_KEY, // Tetap dipakai untuk orderan (Atlantic)
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};


// === GMAIL GATEWAY: XS-PEDIA -> THERESA (UPSTREAM INTERNAL) ===
// Base URL yang terlihat oleh client tetap XS-Pedia.
// URL upstream + API key Theresa hanya dipakai server-side.
const GMAIL_THERESA_BASE =
  process.env.GMAIL_THERESA_BASE ||
  "https://api.theresav.biz.id/premium/alightmotion";

const GMAIL_THERESA_APIKEY = process.env.GMAIL_THERESA_APIKEY || "RyuuXiao";

const GMAIL_LIMITS = {
  user: process.env.GMAIL_USER_LIMIT || "1/hari",
  reseller: process.env.GMAIL_RESELLER_LIMIT || "5/hari",
  vip: process.env.GMAIL_VIP_LIMIT || "VIP",
};

function getGmailAccess(user) {
  const role = String(user?.role || "user").toLowerCase();
  const tier = ["vip", "premium"].includes(role) ? "vip" : role;
  return {
    username: user?.username || "-",
    role,
    tier,
    vip: tier === "vip",
    limit: GMAIL_LIMITS[tier] || GMAIL_LIMITS.user,
  };
}

function buildGmailUpstreamUrl(action, params = {}) {
  const base = GMAIL_THERESA_BASE.replace(/\/+$/, "");
  const url = new URL(`${base}/${action}`);
  url.searchParams.set("apikey", GMAIL_THERESA_APIKEY);
  if (params.email) url.searchParams.set("email", params.email);
  if (params.link) url.searchParams.set("link", params.link);
  return url.toString();
}

function upstreamSuccess(data) {
  if (!data || typeof data !== "object") return false;
  if (data.success === true || data.status === true) return true;
  if (typeof data.status === "string" && ["success", "ok", "true", "sent", "verified"].includes(data.status.toLowerCase())) {
    return true;
  }
  return false;
}

function upstreamMessage(data, fallback) {
  return data?.message || data?.msg || data?.error || fallback;
}

async function forwardGmail(action, params = {}) {
  const upstreamUrl = buildGmailUpstreamUrl(action, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "user-agent": "XS-Pedia-Gmail-Gateway/1.0",
      },
      signal: controller.signal,
    });

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

function gmailDocsHtml(basePath) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>XS-Pedia Gmail API Docs</title>
<style>
body{font-family:Arial,sans-serif;background:#f6f8ff;color:#1f2430;margin:0;padding:24px}
.card{max-width:980px;margin:auto;background:#fff;border:1px solid #e5e8f2;border-radius:20px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
pre{background:#f3f6fd;border-radius:12px;padding:14px;overflow:auto;white-space:pre-wrap;word-break:break-word}
code{background:#f3f6fd;padding:2px 5px;border-radius:6px}
small{color:#687084}
</style>
</head>
<body>
<div class="card">
<h1>XS-Pedia Gmail API</h1>
<p><small>Base public: https://xs-pedia.my.id</small></p>

<h2>1. Send Gmail</h2>
<pre>GET https://xs-pedia.my.id${basePath}/send?email=user%40gmail.com&amp;apikey=APIKEY</pre>

<h2>Response Send</h2>
<pre>{
  "success": true,
  "source": "xs-pedia",
  "endpoint": "send",
  "message": "Link verifikasi berhasil dikirim.",
  "data": {
    "email": "user@gmail.com",
    "access": {
      "username": "demo",
      "role": "vip",
      "tier": "vip",
      "vip": true,
      "limit": "VIP"
    }
  }
}</pre>

<h2>2. Verify Gmail</h2>
<pre>GET https://xs-pedia.my.id${basePath}/verify?email=user%40gmail.com&amp;link=LINK_DARI_GMAIL&amp;apikey=APIKEY</pre>

<h2>Response Verify</h2>
<pre>{
  "success": true,
  "source": "xs-pedia",
  "endpoint": "verify",
  "message": "Link berhasil diverifikasi.",
  "data": {
    "email": "user@gmail.com",
    "access": {
      "username": "demo",
      "role": "vip",
      "tier": "vip",
      "vip": true,
      "limit": "VIP"
    }
  }
}</pre>

<h2>Header alternatif</h2>
<pre>X-API-Key: APIKEY</pre>
<p>API key client hanya dipakai untuk autentikasi XS-Pedia. API key upstream tidak pernah dikirim ke browser.</p>
</div>
</body>
</html>`;
}

function gmailOk(endpoint, payload = {}) {
  return {
    success: true,
    source: "xs-pedia",
    endpoint,
    ...payload,
  };
}

function gmailFail(endpoint, message, extra = {}) {
  return {
    success: false,
    source: "xs-pedia",
    endpoint,
    message,
    ...extra,
  };
}

router.get("/profile", validateApiKey, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found after API key validation",
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        fullname: user.fullname,
        username: user.username,
        nomor: user.nomor,
        email: user.email,
        profileUrl: user.profileUrl,
        saldo: user.saldo,
        coin: user.coin,
        tanggalDaftar: user.tanggalDaftar,
        role: user.role,
        isVerified: user.isVerified,
        lastLogin: user.lastLogin,
        referralCode: user.referralCode,
      },
    });
  } catch (error) {
    console.error("Error fetching user profile via API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.get("/mutasi", validateApiKey, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found after API key validation",
      });
    }

    const historyDeposit = user.historyDeposit || [];
    const historyOrder = user.historyOrder || [];

    historyDeposit.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    historyOrder.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.status(200).json({
      success: true,
      mutasiDeposit: historyDeposit,
      mutasiOrder: historyOrder,
    });
  } catch (error) {
    console.error("Error fetching mutation history via API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});
// === ROUTE DAFTAR METODE (STRUKTUR ASLI - PAYINAJA) ===
router.get("/deposit/metode", validateApiKey, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.user?.role || "user";
    
    // Fee sesuai role (0.1% reseller, 0.2% user)
    const feeDesimal = role === "reseller" ? 0.001 : 0.002;
    const feePersen = (feeDesimal * 100).toString(); 

    const metodeFormatted = [{
      metode: "QRIS",
      type: "ewallet",
      name: "QRIS All Payment (Otomatis)",
      min: 500,
      max: 5000000,
      fee: 0,
      fee_persen: feePersen,
      status: "aktif",
      img_url: `${fullUrl}/media/metode/qrisfast.png`, // Gunakan path lokal kamu
    }];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Payinaja",
      metode: metodeFormatted,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal mengambil metode." });
  }
});

// === ROUTE BUAT DEPOSIT (UPDATE ENDPOINT PAYINAJA & FIX FETCH) ===
router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { nominal } = req.query;

  if (!nominal || isNaN(nominal)) {
    return res.status(400).json({ success: false, message: "Nominal tidak valid." });
  }

  const parsedNominal = parseInt(nominal);
  if (parsedNominal < 500) {
    return res.status(400).json({ success: false, message: "Minimal deposit Rp500" });
  }

  const API_KEY = process.env.PAYINAJA_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ success: false, message: "API Key Payinaja belum disetting." });
  }

  try {
    let response;
    try {
      // Request ke Payinaja menggunakan endpoint terbaru + Header Anti-Block (User-Agent)
      response = await fetch("https://payinaja.com/api/v1/qris/create2", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "x-api-key": API_KEY 
        },
        body: JSON.stringify({
          amount: parsedNominal,
          reference_id: `DEP-${Date.now()}`,
          customer_name: user.username || "Pelanggan"
        })
      });
    } catch (fetchError) {
      console.error("Fetch API Error:", fetchError);
      return res.status(502).json({ success: false, message: "Koneksi server ke Payinaja gagal/diblokir." });
    }

    const result = await response.json();
    
    if (!result || !result.success) {
      return res.status(502).json({ success: false, message: result?.message || "Gagal membuat QRIS." });
    }

    // Data dari API Payinaja terbaru
    const payData = result.data;

    // KALKULASI ANTI-NaN (menggunakan key dari response docs terbaru)
    const nominalAsli = Number(payData.amount_requested) || parsedNominal;
    const feePayinaja = Number(payData.fee) || 0;
    const totalBayar = Number(payData.total_amount) || (nominalAsli + feePayinaja);
    
    const feePercent = user.role === "reseller" ? 0.001 : 0.002;
    let additionalFee = Math.ceil(nominalAsli * feePercent);
    const finalBalance = nominalAsli - additionalFee;

    const history = {
      id: payData.payinaja_trx_id,
      nominal: nominalAsli,
      fee: additionalFee + feePayinaja, 
      get_balance: finalBalance,
      metode: "QRIS",
      status: "pending",
      qr_image: payData.qris_image_url,
      created_at: new Date(),
    };

    // Gunakan fungsi internal kamu tanpa ada perubahan agar tidak error/null
    await tambahHistoryDeposit(user._id, history);

    res.status(200).json({
      success: true,
      data: {
        id: history.id,
        nominal: nominalAsli,
        qr_image: history.qr_image,
        fee: history.fee,
        get_balance: history.get_balance,
        total_amount: totalBayar,
        status: "pending"
      },
    });

    // POLLING OTOMATIS (Tanpa cloudscraper agar tidak crash, ditambah User-Agent)
    const intervalId = setInterval(async () => {
      try {
        const checkRes = await fetch(`https://payinaja.com/api/v1/transaction/${payData.payinaja_trx_id}`, {
          method: "GET",
          headers: { 
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "x-api-key": API_KEY 
          }
        });
        const statusData = await checkRes.json();

        if (statusData?.success && statusData.data) {
          const apiStatus = statusData.data.status.toLowerCase();
          
          if (apiStatus === "success") {
            const userCheck = await User.findOne({ _id: user._id, "historyDeposit.id": payData.payinaja_trx_id });
            const txInDb = userCheck?.historyDeposit?.find(tx => tx.id === payData.payinaja_trx_id);

            if (txInDb && txInDb.status !== "success") {
              await editHistoryDeposit(user._id, payData.payinaja_trx_id, "success");
              await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalBalance } });
            }
            clearInterval(intervalId);
          } else if (["failed", "expired", "cancel"].includes(apiStatus)) {
            await editHistoryDeposit(user._id, payData.payinaja_trx_id, apiStatus);
            clearInterval(intervalId);
          }
        }
      } catch (e) { 
        console.error("Polling API Error:", e.message);
        clearInterval(intervalId); 
      }
    }, 10000);

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// === ROUTE CEK STATUS (STRUKTUR ASLI - PAYINAJA) ===
router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { id } = req.query;
  const { user } = req;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne({ _id: user._id, "historyDeposit.id": id }, { "historyDeposit.$": 1 });
    if (!userHistory) return res.status(404).json({ success: false, message: "Data tidak ditemukan di DB." });

    const localData = userHistory.historyDeposit[0];

    // Cek ke API Payinaja
    const response = await fetch(`https://payinaja.com/api/v1/transaction/${id}`, {
        method: "GET",
        headers: { "x-api-key": process.env.PAYINAJA_API_KEY }
    });
    const result = await response.json();
    
    if (!result.success) return res.status(404).json({ success: false, message: "Data tidak ditemukan di provider." });

    // Update status jika sudah sukses di provider tapi pending di DB
    const apiStatus = result.data.status.toLowerCase();
    if (apiStatus === "success" && localData.status !== "success") {
        await editHistoryDeposit(user._id, id, "success");
        await User.findByIdAndUpdate(user._id, { $inc: { saldo: Number(localData.get_balance) || 0 } });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: id,
        status: apiStatus,
        nominal: Number(result.data.amount_requested),
        fee: localData.fee || 0,
        get_balance: localData.get_balance || 0,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// === ROUTE CANCEL (STRUKTUR ASLI - LOCAL ONLY) ===
router.get("/deposit/cancel", validateApiKey, async (req, res) => {
  const { user } = req;
  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne({ _id: user._id, "historyDeposit.id": id });
    if (!userHistory) return res.status(404).json({ success: false, message: "Data tidak ditemukan." });

    // Update status di database internal saja
    await editHistoryDeposit(user._id, id, "cancel");

    return res.status(200).json({
      success: true,
      data: { id, status: "cancel" },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get("/layanan/price-list", validateApiKey, async (req, res) => {
  const {
    user
  } = req;
  const {
    code
  } = req.query;

  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: code,
    };

    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders,
    });

    const responseBody = JSON.parse(response);

    if (!responseBody || !responseBody.status || !Array.isArray(responseBody.data)) {
      return res.status(502).json({
        success: false,
        message: responseBody?.message || "Gagal mendapatkan daftar harga.",
        error: responseBody?.data || responseBody,
      });
    }

    const modifiedData = responseBody.data.map((item) => {
      let originalPrice = parseInt(item.price) || 0;
      let modifiedPrice = originalPrice;

      if (user.role === "user") {
        modifiedPrice = originalPrice + 100;
      } else if (user.role === "reseller") {
        modifiedPrice = originalPrice + 50;
      }

      return {
        code: item.code,
        name: item.name,
        category: item.category,
        type: item.type,
        provider: item.provider,
        price: modifiedPrice.toString(),
        note: item.note,
        status: item.status,
        img_url: item.img_url,
      };
    });

    return res.status(200).json({
      success: true,
      data: modifiedData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || "Terjadi kesalahan internal saat memproses permintaan.",
      error: error,
    });
  }
});

router.get("/order/create", validateApiKey, async (req, res) => {
  const {
    user
  } = req;
  const {
    code,
    tujuan: target
  } = req.query;

  if (!code || !target) {
    return res.status(400).json({
      success: false,
      message: "Kode layanan dan tujuan harus diisi.",
    });
  }

  try {
    const formDataToAtlanticPriceList = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: code,
    };

    const atlanticPriceListResponse = await cloudscraper.post(
      `${BASE_URL}/layanan/price_list`, {
        body: qs.stringify(formDataToAtlanticPriceList),
        headers: cloudscraperHeaders,
      }
    );

    const priceListResult = JSON.parse(atlanticPriceListResponse);

    if (!priceListResult || !priceListResult.status || !priceListResult.data) {
      return res.status(502).json({
        success: false,
        message: priceListResult?.message || "Gagal mendapatkan daftar harga.",
        error: priceListResult?.data || priceListResult,
      });
    }

    const productList = Array.isArray(priceListResult.data) ? priceListResult.data : [priceListResult.data];
    const product = productList.find((item) => item.code === code && item.status === "available");

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Kode layanan tidak ditemukan atau tidak tersedia.",
      });
    }

    let originalPrice = parseInt(product.price) || 0;
    let modifiedPrice = originalPrice;

    if (user.role === "user") {
      modifiedPrice = originalPrice + 500;
    } else if (user.role === "reseller") {
      modifiedPrice = originalPrice + 350;
    }

    if (user.saldo < modifiedPrice) {
      return res.status(400).json({
        success: false,
        message: "Saldo Anda tidak mencukupi untuk melakukan transaksi ini.",
      });
    }

    const reff_id = generateReffId();

    const formDataToAtlanticCreate = {
      api_key: process.env.ATLAN_API_KEY,
      code: code,
      reff_id: reff_id,
      target: target,
      type: "prabayar",
    };

    const atlanticCreateResponse = await cloudscraper.post(
      `${BASE_URL}/transaksi/create`, {
        body: qs.stringify(formDataToAtlanticCreate),
        headers: cloudscraperHeaders,
      }
    );

    const createResult = JSON.parse(atlanticCreateResponse);

    if (!createResult || !createResult.status || !createResult.data) {
      return res.status(502).json({
        success: false,
        message: createResult?.message || "Gagal membuat transaksi ke provider.",
        error: createResult?.data || createResult,
      });
    }

    const transactionDetails = createResult.data;

    await User.findByIdAndUpdate(user._id, {
      $inc: {
        saldo: -modifiedPrice
      },
    });

    const historyDataForDb = {
      id: transactionDetails.id,
      reff_id: transactionDetails.reff_id,
      layanan: transactionDetails.layanan,
      code: transactionDetails.code,
      target: transactionDetails.target,
      price: modifiedPrice.toString(),
      sn: transactionDetails.sn || null,
      status: transactionDetails.status,
      created_at: transactionDetails.created_at ?
        new Date(transactionDetails.created_at) :
        new Date(),
    };
    await tambahHistoryOrder(user._id, historyDataForDb);

    const maxPollingTime = 5 * 60 * 1000;
    const startTime = Date.now();
    const intervalId = setInterval(async () => {
      try {
        const checkStatusResponse = await cloudscraper.post(
          `${BASE_URL}/transaksi/status`, {
            body: qs.stringify({
              api_key: process.env.ATLAN_API_KEY,
              id: transactionDetails.id,
              type: "prabayar",
            }),
            headers: cloudscraperHeaders,
          }
        );

        const statusUpdateData = JSON.parse(checkStatusResponse);

        if (statusUpdateData && statusUpdateData.status && statusUpdateData.data) {
          const currentTxStatus = statusUpdateData.data.status;
          const currentSn = statusUpdateData.data.sn || null;

          await editHistoryOrder(user._id, transactionDetails.id, {
            status: currentTxStatus,
            sn: currentSn,
          });

          if (currentTxStatus === "success") {
            clearInterval(intervalId);
          }

          if (["failed", "cancel"].includes(currentTxStatus)) {
            await User.findByIdAndUpdate(user._id, {
              $inc: {
                saldo: modifiedPrice
              },
            });
            clearInterval(intervalId);
          }

          if (
            ["success", "failed", "cancel"].includes(currentTxStatus) ||
            Date.now() - startTime > maxPollingTime
          ) {
            clearInterval(intervalId);
          }
        }
      } catch (pollError) {
        console.error(pollError?.response?.data || pollError.message);
      }
    }, 1000);

    return res.status(200).json({
      success: true,
      data: {
        ...transactionDetails,
        price: modifiedPrice.toString(),
      },
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memproses order.",
      error: apiError || error.message,
    });
  }
});

router.get("/order/check", validateApiKey, async (req, res) => {
  const {
    user
  } = req;
  const {
    id
  } = req.query;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID order harus diisi.",
    });
  }

  try {
    const userWithOrder = await User.findOne({
      _id: user._id,
      "historyOrder.id": id
    }, {
      "historyOrder.$": 1
    });

    if (!userWithOrder || !userWithOrder.historyOrder.length) {
      return res.status(404).json({
        success: false,
        message: "Order Tidak Ditemukan Di Mutasi Anda.",
      });
    }

    const formDataToAtlanticStatus = {
      api_key: process.env.ATLAN_API_KEY,
      id: id,
      type: "prabayar",
    };

    const checkStatusResponse = await cloudscraper.post(
      `${BASE_URL}/transaksi/status`, {
        body: qs.stringify(formDataToAtlanticStatus),
        headers: cloudscraperHeaders,
      }
    );

    const statusResult = JSON.parse(checkStatusResponse);

    if (!statusResult || !statusResult.status || !statusResult.data) {
      return res.status(502).json({
        success: false,
        message: statusResult?.message || "Gagal memeriksa status order.",
        error: statusResult?.data || statusResult,
      });
    }

    const orderDetails = statusResult.data;

    return res.status(200).json({
      status: true,
      data: {
        id: orderDetails.id,
        reff_id: orderDetails.reff_id,
        layanan: orderDetails.layanan,
        code: orderDetails.code,
        target: orderDetails.target,
        price: orderDetails.price,
        sn: orderDetails.sn || null,
        status: orderDetails.status,
        created_at: orderDetails.created_at,
      },
      code: 200,
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memeriksa status order.",
      error: apiError || error.message,
    });
  }
});

router.get("/order-panel", validateApiKey, async (req, res) => {
  const {
    username,
    paket
  } = req.query;
  const user = req.user;
  const availablePackets = ["1gb", "2gb", "3gb", "4gb", "5gb", "6gb", "7gb", "8gb", "9gb", "20gb", "unli"];
  if (!username) {
    return res.status(400).json({
      success: false,
      message: "Parameter 'username' harus diisi",
    });
  }
  if (!paket || !availablePackets.includes(paket.toLowerCase())) {
    return res.status(400).json({
      success: false,
      message: `Paket tidak valid. Paket yang tersedia: ${availablePackets.join(", ")}`,
    });
  }
  let memo, disk, cpu, harga;
  switch (paket.toLowerCase()) {
    case "1gb":
      memo = 1024;
      disk = 1024;
      cpu = 50;
      harga = 1000;
      break;
    case "2gb":
      memo = 2048;
      disk = 2048;
      cpu = 100;
      harga = 2000;
      break;
    case "3gb":
      memo = 3072;
      disk = 3072;
      cpu = 150;
      harga = 3000;
      break;
    case "4gb":
      memo = 4096;
      disk = 4096;
      cpu = 200;
      harga = 4000;
      break;
    case "5gb":
      memo = 5120;
      disk = 5120;
      cpu = 250;
      harga = 5000;
      break;
    case "6gb":
      memo = 6144;
      disk = 6144;
      cpu = 300;
      harga = 6000;
      break;
    case "7gb":
      memo = 7168;
      disk = 7168;
      cpu = 350;
      harga = 7000;
      break;
    case "8gb":
      memo = 8192;
      disk = 8192;
      cpu = 400;
      harga = 8000;
      break;
    case "9gb":
      memo = 9216;
      disk = 9216;
      cpu = 450;
      harga = 9000;
      break;
    case "10gb":
      memo = 10240;
      disk = 10240;
      cpu = 500;
      harga = 10000;
      break;
    case "unli":
      memo = 0;
      disk = 0;
      cpu = 0;
      harga = 15000;
      break;
    default:
      return res.status(400).json({
        success: false,
        message: "Paket tidak dikenali",
      });
  }
  let modifiedHarga = harga;
  if (user.role === "user") {
    modifiedHarga = harga + 10;
  } else if (user.role === "reseller") {
    modifiedHarga = harga + 7;
  }
  if (user.saldo < modifiedHarga) {
    await tambahHistoryOrder(user._id, {
      id: generateReffId(),
      layanan: `Panel ${paket}`,
      code: paket.toUpperCase(),
      target: username,
      price: modifiedHarga.toString(),
      status: "Gagal - Saldo tidak mencukupi",
      created_at: new Date(),
    });
    return res.status(400).json({
      success: false,
      message: "Saldo tidak mencukupi",
    });
  }
  try {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apikey}`,
    };
    const email = `${username}@gmail.com`;
    const password = `${username}${disk}`;
    const reff_id = generateReffId();
    const createUserResponse = await cloudscraper.post(
      `${domain}/api/application/users`, {
        body: JSON.stringify({
          email,
          username,
          first_name: username,
          last_name: username,
          language: "en",
          password,
        }),
        headers
      }
    );
    const newUser = JSON.parse(createUserResponse).attributes;
    const createServerResponse = await cloudscraper.post(
      `${domain}/api/application/servers`, {
        body: JSON.stringify({
          name: username,
          description: "Server dibuat via API Buy Panel",
          user: newUser.id,
          egg: 15,
          docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
          startup: "npm start",
          environment: {
            INST: "npm",
            USER_UPLOAD: "0",
            AUTO_UPDATE: "0",
            CMD_RUN: "npm start",
            JS_FILE: "index.js",
          },
          limits: {
            memory: memo,
            swap: 0,
            disk,
            io: 500,
            cpu,
          },
          feature_limits: {
            databases: 5,
            backups: 5,
            allocations: 5,
          },
          deploy: {
            locations: [1],
            dedicated_ip: false,
            port_range: [],
          },
        }),
        headers
      }
    );
    const newServer = JSON.parse(createServerResponse).attributes;
    await User.findByIdAndUpdate(user._id, {
      $inc: {
        saldo: -modifiedHarga
      },
    });
    await tambahHistoryOrder(user._id, {
      id: reff_id,
      reff_id,
      layanan: `Panel ${paket}`,
      code: paket.toUpperCase(),
      target: username,
      price: modifiedHarga.toString(),
      status: "Sukses",
      created_at: new Date(),
    });
    return res.status(201).json({
      success: true,
      message: "Server berhasil dibuat",
      data: {
        id: reff_id,
        reff_id,
        layanan: `Panel ${paket}`,
        code: paket.toUpperCase(),
        target: username,
        price: modifiedHarga.toString(),
        status: "Sukses",
        created_at: new Date(),
        user: {
          id: newUser.id,
          username: newUser.username,
          email,
          password,
        },
        server: {
          id: newServer.id,
          name: newServer.name,
          memory: memo,
          disk,
          cpu,
        },
      },
    });
  } catch (error) {
    await tambahHistoryOrder(user._id, {
      id: generateReffId(),
      layanan: `Panel ${paket}`,
      code: paket.toUpperCase(),
      target: username,
      price: modifiedHarga.toString(),
      status: "Gagal - Internal server error",
      created_at: new Date(),
    });
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat server",
      error: error.response?.data || error.message,
    });
  }
});

// === GMAIL ROUTES: PUBLIC XS-PEDIA API ===
router.get("/h2h/gmail/docs", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(gmailDocsHtml("/h2h/gmail"));
});

router.get("/h2h/gmail/send", validateApiKey, async (req, res) => {
  const email = String(req.query.email || "").trim();
  const user = req.user;

  if (!email) {
    return res.status(400).json(gmailFail("send", 'Parameter "email" diperlukan.'));
  }
  if (!user) {
    return res.status(401).json(gmailFail("send", "User tidak ditemukan."));
  }

  try {
    const access = getGmailAccess(user);
    const upstream = await forwardGmail("send", { email });

    if (!upstream.ok || !upstreamSuccess(upstream.data)) {
      return res.status(502).json(gmailFail(
        "send",
        upstreamMessage(upstream.data, "Upstream gagal mengirim link verifikasi."),
        { data: { email, access } }
      ));
    }

    return res.status(200).json(gmailOk("send", {
      message: "Link verifikasi berhasil dikirim.",
      data: {
        email,
        access,
        status: "pending",
      },
    }));
  } catch (error) {
    console.error("Gmail send gateway error:", error);
    return res.status(502).json(gmailFail(
      "send",
      error.name === "AbortError" ? "Upstream timeout." : (error.message || "Gagal mengirim link verifikasi.")
    ));
  }
});

router.get("/h2h/gmail/verify", validateApiKey, async (req, res) => {
  const email = String(req.query.email || "").trim();
  const link = String(req.query.link || "").trim();
  const user = req.user;

  if (!email) {
    return res.status(400).json(gmailFail("verify", 'Parameter "email" diperlukan.'));
  }
  if (!link) {
    return res.status(400).json(gmailFail("verify", 'Parameter "link" diperlukan.'));
  }
  if (!user) {
    return res.status(401).json(gmailFail("verify", "User tidak ditemukan."));
  }

  try {
    const access = getGmailAccess(user);
    const upstream = await forwardGmail("verify", { email, link });

    if (!upstream.ok || !upstreamSuccess(upstream.data)) {
      return res.status(502).json(gmailFail(
        "verify",
        upstreamMessage(upstream.data, "Upstream gagal memverifikasi link."),
        { data: { email, access } }
      ));
    }

    return res.status(200).json(gmailOk("verify", {
      message: "Link berhasil diverifikasi.",
      data: {
        email,
        access,
        status: "success",
      },
    }));
  } catch (error) {
    console.error("Gmail verify gateway error:", error);
    return res.status(502).json(gmailFail(
      "verify",
      error.name === "AbortError" ? "Upstream timeout." : (error.message || "Gagal memverifikasi link.")
    ));
  }
});

module.exports = router;
