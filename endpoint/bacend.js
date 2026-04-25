const express = require("express");
const qs = require("qs");
const multer = require('multer');
const PUSATPPOB_BASE_URL = "https://www.pusatppob.com";
const nodeCrypto = require("crypto");
const cloudscraper = require("cloudscraper");
const upload = multer();
const app = express();
const router = express.Router();
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());

const domain = process.env.PTERO_DOMAIN;
const apikey = process.env.PTERO_API_KEY;

// KONFIGURASI RICHMARKET
const PAYINAJA_API_KEY = process.env.RICH_API_KEY;
const PAYINAJA_BASE_URL = "https://payinaja.com/api/v1";

const {
  requireLogin,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL, // Ini untuk Atlantic (Orderan)
  ATLAN_API_KEY, // Ini untuk Atlantic
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";
    const feePersen = role === "reseller" ? "0.1" : "0.2";

    // URL for the QR code or QRIS image generated from Payinaja API
    const qrisImageUrl = "https://quickchart.io/qr?text=your_text_here&size=300"; // Change with your dynamic value

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit",
      metode: [{
        metode: "QRIS",
        type: "ewallet",
        name: "QRIS  (Otomatis)",
        min: 200,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen,
        status: "aktif",
        img_url: qrisImageUrl,  // Here you should replace with actual QR URL
      }]
    });

  } catch (e) {
    return res.status(500).json({ success: false, message: "Gagal mengambil metode." });
  }
});
router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      return res.status(401).json({ success: false, message: "Sesi tidak valid." });
    }

    const { nominal } = req.body;

    // 1. Validasi Input
    if (!nominal || isNaN(nominal)) {
      return res.status(400).json({ success: false, message: "Nominal tidak valid." });
    }

    const parsedNominal = parseInt(nominal, 10);
    if (parsedNominal < 200) {
      return res.status(400).json({ success: false, message: "Minimal deposit Rp200" });
    }

    // 2. Konfigurasi API Payinaja
    const API_KEY = process.env.PAYINAJA_API_KEY;
    const BASE_URL = process.env.PAYINAJA_BASE_URL || "https://payinaja.web.id/api/v1";

    if (!API_KEY) {
      return res.status(500).json({ success: false, message: "Konfigurasi API Key (Payinaja) belum diatur di ENV." });
    }

    // 3. Request ke Payinaja
    const payinajaResponse = await fetch(`${BASE_URL}/qris/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({
        amount: parsedNominal,
        reference_id: `INV-${Date.now()}`,
        customer_name: user.username || user.name || "Customer",
      }),
    });

    const result = await payinajaResponse.json();

    if (!result.success) {
      return res.status(502).json({ 
        success: false, 
        message: result.message || "Gagal mendapatkan QRIS dari provider." 
      });
    }

    const d = result.data;

    // 4. Perhitungan Fee Internal & Saldo Diterima (Mencegah NaN)
    // Pastikan user.role ada, jika tidak default ke 0.2
    const feePercent = user.role === "reseller" ? 0.1 : 0.2;
    const internalFee = Math.round(parsedNominal * feePercent);
    const finalBalance = parsedNominal - internalFee;

    // 5. Simpan ke Database
    const history = {
      id: d.payinaja_trx_id,
      reff_id: d.merchant_ref,
      nominal: parsedNominal, // Nominal asli yang diinput user
      fee: internalFee,       // Biaya admin internal Anda
      get_balance: finalBalance,
      metode: "QRIS",
      status: d.status,
      total: d.total_amount,  // Total yang harus dibayar user (termasuk fee provider)
      uniq: d.qris_string,
      qris_image_url: d.qris_image_url,
      created_at: new Date(),
    };

    await tambahHistoryDeposit(user._id, history);

    // 6. Response ke Frontend
    return res.status(200).json({
      success: true,
      message: "QRIS berhasil dibuat",
      data: {
        id: d.payinaja_trx_id,
        nominal: parsedNominal,
        fee: internalFee,       // Dikirim agar "Biaya Admin" tidak NaN
        total_bayar: d.total_amount,
        get_balance: finalBalance,
        status: d.status,
        metode: "QRIS",
        qris_string: d.qris_string,
        qris_image_url: d.qris_image_url // Gunakan ini di tag <img src="...">
      },
    });

  } catch (err) {
    console.error("Deposit Error:", err);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});


router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const { id } = req.body; // Ini payinaja_trx_id (TRX-...)

    const API_KEY = process.env.PAYINAJA_API_KEY;
    const BASE_URL = process.env.PAYINAJA_BASE_URL || "https://payinaja.web.id/api/v1";

    const response = await fetch(`${BASE_URL}/transaction/${id}`, {
      method: "GET",
      headers: { "x-api-key": API_KEY }
    });

    const result = await response.json();
    if (!result.success) return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan." });

    const d = result.data;
    const statusApi = d.status.toLowerCase();

    // Cari riwayat di database kamu berdasarkan ID provider
    const history = user.history_deposit.find(h => h.id === id);
    if (!history) return res.status(404).json({ success: false, message: "Data tidak ditemukan." });

    // JIKA PEMBAYARAN BERHASIL
    if (statusApi === "success" && history.status === "pending") {
        await editHistoryDeposit(user._id, id, "success");
        await User.findByIdAndUpdate(user._id, { $inc: { saldo: history.get_balance } });
        return res.status(200).json({ 
            success: true, 
            status: "success", 
            message: "Pembayaran Berhasil", 
            get_balance: history.get_balance 
        });
    } 
    
    // JIKA MASIH PENDING / BELUM TRANSFER
    if (statusApi === "pending" || statusApi === "unpaid") {
        return res.status(200).json({ 
            success: true, 
            status: "pending", 
            message: "Menunggu Pembayaran / Belum Dikonfirmasi" 
        });
    }

    // JIKA EXPIRED ATAU GAGAL
    return res.status(200).json({ success: true, status: statusApi, message: "Status: " + statusApi });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const { id } = req.body; // trx_id
  if (!id) return res.status(400).json({ success: false, message: "ID transaksi diperlukan." });

  try {
    const API_KEY = process.env.PAYINAJA_API_KEY; // API_KEY dari ENV
    const BASE_URL = `${process.env.PAYINAJA_BASE_URL}/transaction/cancel/${id}`;

    const response = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "x-api-key": API_KEY, // Menggunakan API_KEY dari ENV
      },
    });

    const result = await response.json();

    if (!result.success) {
      return res.status(404).json({ success: false, message: result.message || "Gagal membatalkan transaksi." });
    }

    await editHistoryDeposit(req.session.userId, id, "cancelled"); // Update status di history

    return res.status(200).json({
      success: true,
      message: "Deposit berhasil dibatalkan.",
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});
router.post("/layanan/price-list", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid.",
    });
  }

  const { code } = req.body; // code = brand (XL/AXIS/DANA) ATAU type (pulsa-reguler/voucher-game/...)

  try {
    const apiId = process.env.PUSATPPOB_API_ID;
    const apiKey = process.env.PUSATPPOB_API_KEY;

    if (!apiId || !apiKey) {
      return res.status(500).json({
        success: false,
        message: "ENV PUSATPPOB_API_ID / PUSATPPOB_API_KEY belum di-set.",
      });
    }

    // FIX: pakai nodeCrypto (sesuai import bacend.js kamu)
    const sign = nodeCrypto
      .createHash("md5")
      .update(String(apiId) + String(apiKey))
      .digest("hex");

    // request ke PusatPPOB PREPAID services
    const formData = {
      key: apiKey,
      sign: sign,
      type: "services",
    };

    // optional filter: pakai "code" biar FE gak berubah
    // auto-detect: kalau ada "-" anggap type, kalau tidak anggap brand
    if (code && String(code).trim() !== "") {
      const v = String(code).trim();

      if (v.includes("-")) {
        // contoh: pulsa-reguler, voucher-game, saldo-e-money, paket-internet, dll
        formData.filter_type = "type";
        formData.filter_value = v;
      } else {
        // contoh: XL, AXIS, DANA, TELKOMSEL, dll
        formData.filter_type = "brand";
        formData.filter_value = v;
      }
    }

    const response = await cloudscraper.post(`${PUSATPPOB_BASE_URL}/api/prepaid`, {
      body: qs.stringify(formData),
      headers: {
        ...(cloudscraperHeaders || {}),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const result = typeof response === "string" ? JSON.parse(response) : response;

    // validasi format pusatppob
    if (!result || result.result !== true || !Array.isArray(result.data)) {
      return res.status(502).json({
        success: false,
        message: result?.message || "Gagal mendapatkan daftar layanan dari provider.",
        error: result,
      });
    }

    const modifiedData = result.data.map((item) => {
      const originalPrice = parseInt(item.price, 10) || 0;
      let modifiedPrice = originalPrice;

      if (user.role === "user") {
        modifiedPrice = originalPrice + 600;
      } else if (user.role === "reseller") {
        modifiedPrice = originalPrice + 260;
      }

      // map ke struktur lama biar FE aman
      return {
        code: item.code,
        name: item.name,
        category: item.type,      // FE kamu pakai category
        type: item.type,          // contoh: pulsa-reguler
        provider: item.brand,     // brand dari pusatppob
        price: String(modifiedPrice),
        note: item.note || "",
        status: item.status || "",
        img_url: "",              // pusatppob biasanya gak ada img_url
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
      error: error?.response?.data || error,
    });
  }
});

router.get("/produk-provider", requireLogin, async (req, res) => {
  const { provider, category } = req.query;

  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({ success: false, message: "User tidak ditemukan." });
  }

  try {
    const apiId = process.env.PUSATPPOB_API_ID;
    const apiKey = process.env.PUSATPPOB_API_KEY;
    if (!apiId || !apiKey) {
      return res.status(500).json({ success: false, message: "ENV PUSATPPOB_API_ID / PUSATPPOB_API_KEY belum di-set." });
    }

    const sign = nodeCrypto.createHash("md5").update(String(apiId) + String(apiKey)).digest("hex");

    const response = await cloudscraper.post(`${PUSATPPOB_BASE_URL}/api/prepaid`, {
      body: qs.stringify({ key: apiKey, sign, type: "services" }),
      headers: cloudscraperHeaders,
    });

    const result = JSON.parse(response);

    if (!result || result.result !== true || !Array.isArray(result.data)) {
      return res.status(502).json({
        success: false,
        message: result?.message || "Provider tidak mengembalikan data services.",
        error: result,
      });
    }

    let data = result.data;

    // optional filter category juga
    const cat = (category || "").toLowerCase().trim();
    if (cat) {
      data = data.filter((item) => {
        const t = String(item.type || item.category || "").toLowerCase();
        if (t === cat) return true;
        if (t.includes(cat)) return true;
        if (cat === "games" || cat === "game") return t.includes("game") || t.includes("voucher");
        return false;
      });
    }

    if (provider) {
      const p = String(provider).toLowerCase().trim();
      data = data.filter((item) => String(item.brand || "").toLowerCase() === p);

      return res.json({ success: true, data });
    }

    // kalau provider kosong → list brand
    const map = {};
    data.forEach((item) => {
      const brand = item.brand || "";
      if (!brand) return;
      if (!map[brand]) map[brand] = { provider: brand, img_url: "" };
    });

    return res.json({ success: true, data: Object.values(map) });

  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: "Gagal memproses data produk/provider.",
      error: errData || error.message,
    });
  }
});
router.get("/produk", requireLogin, async (req, res) => {
  const { category } = req.query;

  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({ success: false, message: "User tidak ditemukan." });
  }

  try {
    const apiId = process.env.PUSATPPOB_API_ID;
    const apiKey = process.env.PUSATPPOB_API_KEY;

    if (!apiId || !apiKey) {
      return res.status(500).json({
        success: false,
        message: "ENV PUSATPPOB_API_ID / PUSATPPOB_API_KEY belum di-set."
      });
    }

    const sign = nodeCrypto
      .createHash("md5")
      .update(String(apiId) + String(apiKey))
      .digest("hex");

    const response = await cloudscraper.post(`${PUSATPPOB_BASE_URL}/api/prepaid`, {
      body: qs.stringify({ key: apiKey, sign, type: "services" }),
      headers: cloudscraperHeaders,
    });

    const result = JSON.parse(response);

    // ✅ validasi struktur provider
    if (!result || result.result !== true || !Array.isArray(result.data)) {
      return res.status(502).json({
        success: false,
        message: result?.message || "Provider tidak mengembalikan data services.",
        error: result,
      });
    }

    const allProduk = result.data;

    // ✅ filter kategori yang fleksibel
    const cat = (category || "").toLowerCase().trim();

    const filtered = !cat
      ? allProduk
      : allProduk.filter((item) => {
          const t = String(item.type || item.category || "").toLowerCase();

          // match biasa (contains)
          if (t === cat) return true;
          if (t.includes(cat)) return true;

          // khusus GAMES
          if (cat === "games" || cat === "game") {
            return t.includes("game") || t.includes("voucher");
          }

          return false;
        });

    // ✅ bikin list provider/brand unik
    const providerMap = {};
    filtered.forEach((item) => {
      const brand = item.brand || "";
      if (!brand) return;
      if (!providerMap[brand]) {
        providerMap[brand] = { provider: brand, img_url: "" };
      }
    });

    return res.json({
      success: true,
      data: Object.values(providerMap),
    });

  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: "Gagal memproses data provider.",
      error: errData || error.message,
    });
  }
});
router.post("/order/create", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    code,
    tujuan: target
  } = req.body;
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
    const priceResponse = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlanticPriceList),
      headers: cloudscraperHeaders,
    });
    const priceListResult = JSON.parse(priceResponse);
    if (!priceListResult || !priceListResult.status || !priceListResult.data) {
      return res.status(502).json({
        success: false,
        message: priceListResult?.message || "Gagal mendapatkan daftar harga dari provider.",
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
      modifiedPrice = originalPrice + 600;
    } else if (user.role === "reseller") {
      modifiedPrice = originalPrice + 260;
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
    const createResponse = await cloudscraper.post(`${BASE_URL}/transaksi/create`, {
      body: qs.stringify(formDataToAtlanticCreate),
      headers: cloudscraperHeaders,
    });
    const createResult = JSON.parse(createResponse);
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
        const statusResponse = await cloudscraper.post(`${BASE_URL}/transaksi/status`, {
          body: qs.stringify({
            api_key: process.env.ATLAN_API_KEY,
            id: transactionDetails.id,
            type: "prabayar",
          }),
          headers: cloudscraperHeaders,
        });
        const statusUpdateData = JSON.parse(statusResponse);
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
            const orderInDb = await User.findOne({
              _id: user._id,
              "historyOrder.id": transactionDetails.id,
              "historyOrder.status": {
                $ne: "failed_refunded"
              }
            }, {
              "historyOrder.$": 1
            });
            if (orderInDb && orderInDb.historyOrder.length > 0 && orderInDb.historyOrder[0].status !== "failed_refunded") {
              await User.updateOne({
                _id: user._id,
                "historyOrder.id": transactionDetails.id
              }, {
                $inc: {
                  saldo: modifiedPrice
                },
                $set: {
                  "historyOrder.$.status": "failed_refunded"
                }
              });
            }
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

router.post("/order/check", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    id
  } = req.body;
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
    const statusResponse = await cloudscraper.post(`${BASE_URL}/transaksi/status`, {
      body: qs.stringify(formDataToAtlanticStatus),
      headers: cloudscraperHeaders,
    });
    const statusResult = JSON.parse(statusResponse);
    if (!statusResult || !statusResult.status || !statusResult.data) {
      return res.status(502).json({
        success: false,
        message: statusResult?.message || "Gagal memeriksa status order dari provider.",
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

module.exports = router;
