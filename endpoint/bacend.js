const express = require("express");
const qs = require("qs");
const multer = require('multer');
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
const GOREKK_API_KEY = process.env.GOREKK_API_KEY;
const GOREKK_BASE_URL = "https://www.gorekk.web.id/api/v1";

// Static QRIS merchant Gorekk
const GOREKK_STATIC_QR = process.env.GOREKK_STATIC_QR || 
"00020101021126610014COM.GO-JEK.WWW01189360091430973426920210G0973426920303UMI51440014ID.CO.QRIS.WWW0215ID10265700401900303UMI5204152053033605802ID5925Toko%20Online%2C%20Konstruksi%20%266009TANGERANG61051512362070703A01630477";

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

//=== ROUTE DAFTAR METODE (HANYA PAYINAJA QRIS) ===
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    // Fee persen untuk tampilan  
    let feePersen = role === "reseller" ? "1.0" : "0.5";  

    // MENGEMBALIKAN METODE PAYINAJA QRIS  
    const metodeFormatted = [{  
      metode: "QRIS",  
      type: "ewallet",  
      name: "QRIS All Payment (Otomatis)",  
      min: 50,  
      max: 5000000,  
      fee: 0,  
      fee_persen: feePersen,  
      status: "aktif",  
      img_url: `${fullUrl}/media/metode/qrisfast.png`,  
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

router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal);

    if (!nominal || isNaN(parsedNominal) || parsedNominal < 500) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp500"
      });
    }

    const API_KEY = process.env.GOREKK_API_KEY;
    const STATIC_QR = process.env.GOREKK_STATIC_QR;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key Gorekk belum disetting di server."
      });
    }

    if (!STATIC_QR) {
      return res.status(500).json({
        success: false,
        message: "Static QR Gorekk belum disetting di server."
      });
    }

    // =========================================================
    // CREATE QRIS GOREKK
    // =========================================================

    const createUrl =
      "https://www.gorekk.web.id/api/v1/qris/create" +
      `?amount=${encodeURIComponent(parsedNominal)}` +
      `&static_qr=${encodeURIComponent(STATIC_QR)}` +
      `&expires_in=60` +
      `&unique_amount=True`;

    let response;

    try {
      response = await fetch(createUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-API-Key": API_KEY
        }
      });
    } catch (fetchError) {
      console.error("Gorekk Fetch API Error:", fetchError);

      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Gorekk gagal."
      });
    }

    let result;

    try {
      result = await response.json();
    } catch (jsonError) {
      console.error("Gorekk JSON Error:", jsonError);

      return res.status(502).json({
        success: false,
        message: "Response dari Gorekk tidak valid."
      });
    }

    if (!response.ok || !result || !result.success) {
      return res.status(400).json({
        success: false,
        message:
          result?.message ||
          "Gagal membuat QRIS Gorekk."
      });
    }

    // =========================================================
    // DATA GOREKK
    // =========================================================

    const invoiceId = result.invoice_id;

    if (!invoiceId) {
      return res.status(502).json({
        success: false,
        message: "Invoice ID tidak diterima dari Gorekk."
      });
    }

    const nominalAsli =
      Number(result.amount) ||
      Number(result.expected_amount) ||
      parsedNominal;

    // =========================================================
    // FEE INTERNAL
    // =========================================================

    let additionalFee = 0;

    if (user.role === "user") {
      additionalFee = Math.ceil(
        nominalAsli * 0.002
      );
    } else if (user.role === "reseller") {
      additionalFee = Math.ceil(
        nominalAsli * 0.001
      );
    }

    // Gorekk response create tidak memberikan fee.
    const feeProvider = 0;

    const totalFee =
      feeProvider + additionalFee;

    const totalBayar = nominalAsli;

    const finalGetBalance =
      nominalAsli - additionalFee;

    // =========================================================
    // SIMPAN HISTORY
    // =========================================================

    const historyDataForDb = {
      id: invoiceId,
      invoice_id: invoiceId,

      nominal: nominalAsli,

      fee: totalFee,

      get_balance: finalGetBalance,

      metode: "QRIS",

      status: "pending",

      qr_image:
        result.image_url || null,

      payment_url:
        result.payment_url || null,

      created_at: new Date()
    };

    await tambahHistoryDeposit(
      user._id,
      historyDataForDb
    );

    // =========================================================
    // RESPONSE KE FRONTEND
    // =========================================================

    res.status(200).json({
      success: true,

      data: {
        id: invoiceId,

        trx_id: invoiceId,

        invoice_id: invoiceId,

        metode: "QRIS",

        nominal: nominalAsli,

        fee: totalFee,

        total_amount: totalBayar,

        expected_amount:
          Number(result.expected_amount) ||
          nominalAsli,

        get_balance: finalGetBalance,

        qr_image:
          result.image_url || null,

        payment_url:
          result.payment_url || null,

        status: "pending",

        expires_at:
          result.expires_at || null
      }
    });

    // =========================================================
    // POLLING STATUS GOREKK
    // =========================================================

    const intervalId = setInterval(async () => {
      try {
        const checkUrl =
          "https://www.gorekk.web.id/api/v1/qris/invoice" +
          `?invoice_id=${encodeURIComponent(invoiceId)}`;

        const checkRes = await fetch(checkUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "X-API-Key": API_KEY
          }
        });

        const checkData =
          await checkRes.json();

        if (
          !checkRes.ok ||
          !checkData?.success ||
          !checkData?.invoice
        ) {
          return;
        }

        const invoice =
          checkData.invoice;

        const providerStatus =
          String(
            invoice.status || "pending"
          ).toLowerCase();

        // =====================================================
        // PAID / SUCCESS
        // =====================================================

        if (
          providerStatus === "paid" ||
          providerStatus === "success"
        ) {
          const userCheck =
            await User.findOne({
              _id: user._id,
              "historyDeposit.id": invoiceId
            });

          const txInDb =
            userCheck?.historyDeposit?.find(
              tx => tx.id === invoiceId
            );

          // Mencegah saldo masuk dua kali
          if (
            txInDb &&
            txInDb.status !== "success"
          ) {
            await editHistoryDeposit(
              user._id,
              invoiceId,
              "success"
            );

            await User.findByIdAndUpdate(
              user._id,
              {
                $inc: {
                  saldo:
                    Number(finalGetBalance) || 0
                }
              }
            );

            console.log(
              `✅ Deposit ${invoiceId} berhasil dibayar.`
            );
          }

          clearInterval(intervalId);

          return;
        }

        // =====================================================
        // FAILED / EXPIRED / CANCEL
        // =====================================================

        if (
          [
            "failed",
            "expired",
            "cancel",
            "cancelled",
            "canceled"
          ].includes(providerStatus)
        ) {
          const finalStatus =
            providerStatus === "cancelled" ||
            providerStatus === "canceled"
              ? "cancel"
              : providerStatus;

          await editHistoryDeposit(
            user._id,
            invoiceId,
            finalStatus
          );

          console.log(
            `❌ Deposit ${invoiceId} status: ${finalStatus}`
          );

          clearInterval(intervalId);
        }

      } catch (e) {
        console.error(
          "Gorekk Polling Error:",
          e.message
        );

        // Jangan stop polling hanya karena
        // satu request mengalami error.
      }
    }, 10000);

    // Safety timeout 15 menit
    setTimeout(() => {
      clearInterval(intervalId);
    }, 15 * 60 * 1000);

  } catch (err) {
    console.error(
      "Deposit Create Error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});


// =============================================================
// ROUTE CEK STATUS DEPOSIT
// =============================================================

router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const user =
      await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID diperlukan."
      });
    }

    // =========================================================
    // AMBIL HISTORY DARI DATABASE
    // =========================================================

    const userWithHistory =
      await User.findOne(
        {
          _id: user._id,
          "historyDeposit.id": id
        },
        {
          "historyDeposit.$": 1
        }
      );

    if (
      !userWithHistory ||
      !userWithHistory.historyDeposit.length
    ) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    const localData =
      userWithHistory.historyDeposit[0];

    const API_KEY =
      process.env.GOREKK_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key Gorekk belum disetting di server."
      });
    }

    // =========================================================
    // CEK STATUS GOREKK
    // =========================================================

    const statusUrl =
      "https://www.gorekk.web.id/api/v1/qris/invoice" +
      `?invoice_id=${encodeURIComponent(id)}`;

    let response;

    try {
      response = await fetch(statusUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "X-API-Key": API_KEY
        }
      });
    } catch (fetchError) {
      console.error(
        "Gorekk Status Fetch Error:",
        fetchError
      );

      // Kalau provider gagal, tetap kirim
      // data lokal agar frontend tidak error.
      return res.status(200).json({
        success: true,
        data: {
          id: id,
          trx_id: id,
          nominal:
            Number(localData.nominal) || 0,
          total_amount:
            Number(localData.nominal) || 0,
          fee:
            Number(localData.fee) || 0,
          get_balance:
            Number(localData.get_balance) || 0,
          status:
            localData.status || "pending",
          metode:
            localData.metode || "QRIS",
          qr_image:
            localData.qr_image || null,
          payment_url:
            localData.payment_url || null
        }
      });
    }

    let result;

    try {
      result = await response.json();
    } catch (jsonError) {
      console.error(
        "Gorekk Status JSON Error:",
        jsonError
      );

      return res.status(200).json({
        success: true,
        data: {
          id: id,
          trx_id: id,
          nominal:
            Number(localData.nominal) || 0,
          total_amount:
            Number(localData.nominal) || 0,
          fee:
            Number(localData.fee) || 0,
          get_balance:
            Number(localData.get_balance) || 0,
          status:
            localData.status || "pending",
          metode:
            localData.metode || "QRIS",
          qr_image:
            localData.qr_image || null
        }
      });
    }

    const invoice =
      result?.invoice;

    // Status provider
    const providerStatus =
      String(
        invoice?.status ||
        localData.status ||
        "pending"
      ).toLowerCase();

    // Gorekk "paid" = sistem internal "success"
    const statusProvider =
      providerStatus === "paid"
        ? "success"
        : providerStatus;

    // =========================================================
    // SINKRONISASI SUCCESS
    // =========================================================

    if (
      statusProvider === "success" &&
      localData.status !== "success"
    ) {
      await User.updateOne(
        {
          _id: user._id,
          "historyDeposit.id": id,
          "historyDeposit.status": {
            $ne: "success"
          }
        },
        {
          $set: {
            "historyDeposit.$.status": "success"
          },

          $inc: {
            saldo:
              Number(localData.get_balance) || 0
          }
        }
      );

      localData.status = "success";
    }

    // =========================================================
    // SINKRONISASI FAILED / EXPIRED / CANCEL
    // =========================================================

    if (
      [
        "failed",
        "expired",
        "cancel",
        "cancelled",
        "canceled"
      ].includes(providerStatus)
    ) {
      const finalStatus =
        providerStatus === "cancelled" ||
        providerStatus === "canceled"
          ? "cancel"
          : providerStatus;

      if (localData.status !== finalStatus) {
        await User.updateOne(
          {
            _id: user._id,
            "historyDeposit.id": id
          },
          {
            $set: {
              "historyDeposit.$.status":
                finalStatus
            }
          }
        );

        localData.status = finalStatus;
      }
    }

    // =========================================================
    // RESPONSE FRONTEND
    // =========================================================

    const nominal =
      Number(invoice?.amount) ||
      Number(invoice?.expected_amount) ||
      Number(localData.nominal) ||
      0;

    const fee =
      Number(localData.fee) || 0;

    const totalAmount =
      Number(invoice?.expected_amount) ||
      Number(invoice?.amount) ||
      nominal;

    const getBalance =
      Number(localData.get_balance) || 0;

    return res.status(200).json({
      success: true,

      data: {
        id: id,

        trx_id: id,

        invoice_id:
          invoice?.id || id,

        nominal: nominal,

        total_amount:
          totalAmount,

        expected_amount:
          Number(invoice?.expected_amount) ||
          nominal,

        fee: fee,

        get_balance:
          getBalance,

        status:
          localData.status ||
          statusProvider,

        metode:
          localData.metode ||
          "QRIS",

        qr_image:
          localData.qr_image ||
          invoice?.metadata?.image_url ||
          null,

        payment_url:
          localData.payment_url ||
          null,

        tx_id:
          invoice?.tx_id ||
          null,

        paid_at:
          invoice?.paid_at ||
          null,

        expires_at:
          invoice?.expires_at ||
          null,

        created_at:
          invoice?.created_at ||
          localData.created_at ||
          null
      }
    });

  } catch (error) {
    console.error(
      "Error Status Check:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Gagal memuat detail terbaru."
    });
  }
});
// === ROUTE CANCEL DEPOSIT (INTERNAL ONLY) ===
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });
  
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    // 1. Pastikan transaksi tersebut memang ada di history user dan statusnya masih pending
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id }, 
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data transaksi tidak ditemukan." });
    }

    const currentData = userHistory.historyDeposit[0];

    // 2. Cegah pembatalan jika statusnya sudah bukan pending (misal sudah success atau sudah cancel)
    if (currentData.status !== "pending") {
      return res.status(400).json({ 
        success: false, 
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.` 
      });
    }

    // 3. Update status di database internal saja (Tanpa fetch ke Payinaja)
    // Menggunakan fungsi helper editHistoryDeposit yang kamu miliki
    await editHistoryDeposit(user._id, id, "cancel");

    return res.status(200).json({
      success: true,
      message: "Deposit berhasil dibatalkan.",
      data: {
        id: id,
        status: "cancel"
      }
    });

  } catch (error) {
    console.error("Cancel Deposit Error:", error);
    res.status(500).json({ success: false, message: "Terjadi kesalahan: " + error.message });
  }
});


router.post("/layanan/price-list", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    code
  } = req.body;
  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: 'prabayar',
      code: code,
    };
    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders
    });
    const resultFromAtlantic = JSON.parse(response);
    if (!resultFromAtlantic || !resultFromAtlantic.status || !Array.isArray(resultFromAtlantic.data)) {
      return res.status(502).json({
        success: false,
        message: resultFromAtlantic?.message || "Gagal mendapatkan daftar harga dari provider.",
        error: resultFromAtlantic?.data || resultFromAtlantic,
      });
    }
    const modifiedData = resultFromAtlantic.data.map((item) => {
      let originalPrice = parseInt(item.price) || 0;
      let modifiedPrice = originalPrice;
      if (user.role === "user") {
        modifiedPrice = originalPrice + 600;
      } else if (user.role === "reseller") {
        modifiedPrice = originalPrice + 260;
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
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memproses permintaan.",
      error: apiError || error.message,
    });
  }
});

router.get("/produk", requireLogin, async (req, res) => {
  const {
    category
  } = req.query;
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }
  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: "",
    };
    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders,
    });
    const result = JSON.parse(response);
    const allProduk = result.data || [];
    const filtered = category ?
      allProduk.filter((item) => item.category?.toLowerCase() === category.toLowerCase()) :
      allProduk;
    const providerMap = {};
    filtered.forEach(item => {
      if (!providerMap[item.provider]) {
        providerMap[item.provider] = {
          provider: item.provider,
          img_url: item.img_url,
        };
      }
    });
    const listProvider = Object.values(providerMap);
    return res.json({
      success: true,
      data: listProvider
    });
  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: errData?.message || "Gagal memproses data provider.",
      error: errData || error.message,
    });
  }
});

router.get("/produk-provider", requireLogin, async (req, res) => {
  const {
    provider
  } = req.query;
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }
  try {
    const formDataToAtlantic = {
      api_key: process.env.ATLAN_API_KEY,
      type: "prabayar",
      code: "",
    };
    const response = await cloudscraper.post(`${BASE_URL}/layanan/price_list`, {
      body: qs.stringify(formDataToAtlantic),
      headers: cloudscraperHeaders,
    });
    const result = JSON.parse(response);
    const allProduk = result.data || [];
    if (provider) {
      const produkByProvider = allProduk.filter(item =>
        item.provider?.toLowerCase() === provider.toLowerCase()
      );
      return res.json({
        success: true,
        data: produkByProvider
      });
    }
    const providerMap = {};
    allProduk.forEach(item => {
      if (!providerMap[item.provider]) {
        providerMap[item.provider] = {
          provider: item.provider,
          img_url: item.img_url,
        };
      }
    });
    const listProvider = Object.values(providerMap);
    return res.json({
      success: true,
      data: listProvider
    });
  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: errData?.message || "Gagal memproses data produk/provider.",
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
