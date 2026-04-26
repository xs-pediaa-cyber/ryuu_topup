const express = require("express");
const qs = require("qs");
const multer = require('multer');
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
const PAYINAJA_BASE_URL = "https://payinaja.web.id/api/v1";

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
    const role = req.session.role || "user";
    // Pastikan fee dalam bentuk angka/float agar frontend bisa menghitung
    const feePersen = role === "reseller" ? 0.01 : 0.02; 

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit",
      metode: [{
        metode: "QRIS",
        type: "ewallet",
        name: "QRIS (Otomatis)",
        min: 200,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen,
        status: "aktif",
        img_url: "https://upload.wikimedia.org/wikipedia/commons/a/a2/QRIS_logo.png",
      }]
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Gagal mengambil metode." });
  }
});

router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });

    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal);

    if (!nominal || isNaN(parsedNominal) || parsedNominal < 200) {
      return res.status(400).json({ success: false, message: "Minimal deposit Rp200" });
    }

    const API_KEY = process.env.PAYINAJA_API_KEY;
    
    // Request QRIS ke Payinaja
    const response = await fetch("https://payinaja.web.id/api/v1/qris/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        amount: parsedNominal,
        reference_id: `DEP-${Date.now()}`,
        customer_name: user.username || "Pelanggan"
      })
    });

    const result = await response.json();
    if (!result || !result.success) {
      return res.status(400).json({ success: false, message: result?.message || "Gagal membuat QRIS." });
    }

    const payData = result.data;

    // --- FIX KALKULASI ANGKA (ANTI-NaN) ---
    const nominalAsli = Number(payData.amount_requested) || parsedNominal;
    const feePayinaja = Number(payData.fee) || 0;
    const totalBayar = Number(payData.total_amount) || (nominalAsli + feePayinaja);
    
    // Logic tambahan fee (karena Payinaja potong saldo merchant, kita sesuaikan get_balance)
    let additionalFee = 0;
    if (user.role === "user") {
      additionalFee = Math.ceil(nominalAsli * 0.002);
    } else if (user.role === "reseller") {
      additionalFee = Math.ceil(nominalAsli * 0.001);
    }

    const totalFee = feePayinaja + additionalFee;
    const finalBalance = nominalAsli - additionalFee;

    const historyDataForDb = {
      id: payData.payinaja_trx_id,
      nominal: nominalAsli,
      fee: totalFee,
      get_balance: finalBalance,
      metode: "QRIS",
      status: "pending",
      qr_image: payData.qris_image_url,
      created_at: new Date(),
    };

    // Simpan ke database lokal
    await tambahHistoryDeposit(user._id, historyDataForDb);

    // Kirim response ke frontend
    res.status(200).json({
      success: true,
      data: {
        ...historyDataForDb,
        total_amount: totalBayar // Untuk tampilan "Total Pembayaran"
      },
    });

    // --- POLLING OTOMATIS (Cek tiap 7 detik) ---
    const intervalId = setInterval(async () => {
      try {
        const checkStatusRes = await fetch(`https://payinaja.web.id/api/v1/transaction/${payData.payinaja_trx_id}`, {
          method: "GET",
          headers: { "x-api-key": API_KEY }
        });
        const statusData = await checkStatusRes.json();

        if (statusData?.success && statusData.data) {
          const apiStatus = statusData.data.status.toLowerCase();

          // Ambil data user & transaksi terbaru dari DB
          const userUpdated = await User.findOne({ 
            _id: user._id, 
            "history_deposit.id": payData.payinaja_trx_id 
          }, { "history_deposit.$": 1 });

          const txInDb = userUpdated?.history_deposit[0];

          if (apiStatus === "success" && txInDb && txInDb.status !== "success") {
            // Update DB Lokal & Tambah Saldo
            await editHistoryDeposit(user._id, payData.payinaja_trx_id, "success");
            await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalBalance } });
            clearInterval(intervalId);
          } else if (["failed", "expired", "cancel"].includes(apiStatus)) {
            await editHistoryDeposit(user._id, payData.payinaja_trx_id, apiStatus);
            clearInterval(intervalId);
          }
        }
      } catch (err) {
        console.error(`Gagal Polling ID ${payData.payinaja_trx_id}:`, err.message);
      }
    }, 1000);

  } catch (error) {
    res.status(500).json({ success: false, message: "Kesalahan internal." });
  }
});
router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const { id } = req.body;
    const user = await User.findById(req.session.userId);

    // 1. Cari data di history deposit user
    const history = (user.history_deposit || user.historyDeposit || []).find(h => h.id === id);

    if (!history) {
      return res.status(200).json({ 
        success: false, 
        message: "Data transaksi tidak ditemukan di sistem." 
      });
    }

    // 2. Jika di database lokal statusnya sudah 'success'
    if (history.status === "success") {
      return res.json({ 
        success: true, 
        status: "success", 
        message: "Pembayaran Berhasil!",
        data: history 
      });
    }

    // 3. Cek status terbaru ke API Payinaja
    const response = await fetch(`https://payinaja.web.id/api/v1/transaction/${id}`, {
      method: "GET",
      headers: { "x-api-key": process.env.PAYINAJA_API_KEY }
    });
    const result = await response.json();

    if (result.success && result.data) {
      const apiStatus = result.data.status.toLowerCase();

      if (apiStatus === "success" && history.status !== "success") {
        const amountToUpdate = Number(history.get_balance) || 0;

        // Update Database
        await editHistoryDeposit(user._id, id, "success");
        await User.findByIdAndUpdate(user._id, { $inc: { saldo: amountToUpdate } });

        // PERBAIKAN DI SINI: Gunakan .toObject() agar data terurai dengan benar dan tidak NaN
        const historyObj = typeof history.toObject === 'function' ? history.toObject() : history;
        
        return res.json({ 
          success: true, 
          status: "success", 
          message: "Pembayaran Berhasil!",
          data: { ...historyObj, status: "success" } // Data aman, tidak akan NaN
        });
      }

      if (["failed", "expired", "cancel"].includes(apiStatus)) {
        await editHistoryDeposit(user._id, id, apiStatus);
        return res.json({ 
          success: true, 
          status: apiStatus, 
          message: `Transaksi ${apiStatus}` 
        });
      }
    }

    return res.json({ 
      success: true, 
      status: "pending", 
      message: "Menunggu pembayaran...",
      data: history
    });

  } catch (err) {
    console.error("Status Check Error:", err.message);
    res.status(500).json({ success: false, message: "Gagal memproses status." });
  }
});
// === ROUTE CANCEL DEPOSIT (LOCAL ONLY UNTUK PAYINAJA) ===
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  try {
    const { id } = req.body;
    const user = await User.findById(req.session.userId);
    
    if (!user) {
      return res.status(401).json({ success: false, message: "Sesi tidak valid." });
    }
    
    if (!id) {
      return res.status(400).json({ success: false, message: "ID transaksi diperlukan." });
    }

    // 1. Cari data di history deposit user (mencari ID TRX)
    // Menggunakan penamaan array yang konsisten dengan route status/create kamu
    const history = (user.history_deposit || user.historyDeposit || []).find(h => h.id === id);

    if (!history) {
      return res.status(404).json({ 
        success: false, 
        message: "Data transaksi tidak ditemukan." 
      });
    }

    // 2. Cek apakah transaksi sudah sukses. Jika sudah sukses, tidak boleh di-cancel.
    if (history.status === "success") {
      return res.status(400).json({ 
        success: false, 
        message: "Transaksi yang sudah sukses tidak dapat dibatalkan." 
      });
    }

    // 3. Update status di database internal menjadi 'cancel'
    // Menggunakan fungsi editHistoryDeposit yang sudah kamu punya
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
    console.error("Cancel Error:", error.message);
    res.status(500).json({ success: false, message: "Terjadi kesalahan server." });
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
