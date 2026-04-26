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
const PAYINAJA_API_KEY = process.env.PAYINAJA_API_KEY;
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

// === ROUTE DAFTAR METODE (HANYA PAYINAJA QRIS) ===
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    // Fee persen untuk tampilan  
    let feePersen = role === "reseller" ? "0.1" : "0.2";  

    // MENGEMBALIKAN METODE PAYINAJA QRIS  
    const metodeFormatted = [{  
      metode: "QRIS",  
      type: "ewallet",  
      name: "QRIS All Payment (Otomatis)",  
      min: 101,  
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

// === ROUTE BUAT DEPOSIT (HANYA PAYINAJA QRIS) ===
router.post("/deposit/create", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });

  const { nominal, reference_id, customer_name } = req.body;
  if (!nominal || isNaN(nominal)) {
    return res.status(400).json({ success: false, message: "Nominal tidak valid." });
  }

  const parsedNominal = parseInt(nominal);
  if (parsedNominal < 101) {
    return res.status(400).json({ success: false, message: "Minimal deposit Rp101" });
  }

  try {
    // Request ke Payinaja API untuk membuat QRIS
    const payinajaResponse = await fetch(`${PAYINAJA_BASE_URL}/api/v1/qris/create`, {
      method: "POST",
      headers: {
        "x-api-key": PAYINAJA_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: parsedNominal,
        reference_id: reference_id || "", // ID Referensi Opsional
        customer_name: customer_name || "Anonymous" // Nama Pelanggan Opsional
      })
    });

    const result = await payinajaResponse.json();  

    if (result.success !== true) {  
      return res.status(502).json({  
        success: false,  
        message: result.message || "Gagal membuat tagihan ke Payinaja.",  
      });  
    }  

    const d = result.data; // trx_id, qr_link, amount  

    // --- PERUBAHAN DISINI: Logika Hitung menggunakan ENV ---  
    const feePercent = user.role === "reseller"   
        ? parseFloat(process.env.FEE_PERCENT_RESELLER)   
        : parseFloat(process.env.FEE_PERCENT_USER);  
      
    let additionalFee = Math.ceil(parsedNominal * feePercent);  
    const finalBalance = parsedNominal - additionalFee;  

    const history = {  
      id: d.payinaja_trx_id,  
      reff_id: `XIAO_${Date.now()}`,  
      nominal: parsedNominal,  
      fee: additionalFee, // Disimpan ke DB agar tidak NaN  
      get_balance: finalBalance, // Disimpan ke DB agar tidak NaN  
      metode: "QRIS",  
      status: "pending",  
      qr_image: d.qris_image_url,  
      created_at: new Date(),  
    };  

    await tambahHistoryDeposit(user._id, history);  

    // Kirim respon lengkap agar modal frontend tidak NaN  
    res.status(200).json({  
      success: true,  
      data: {  
        id: d.payinaja_trx_id,  
        nominal: parsedNominal,  
        qr_image: d.qris_image_url,  
        fee: additionalFee,  
        get_balance: finalBalance,  
        status: "pending"  
      },  
    });  

    // POLLING STATUS PAYINAJA  
    const intervalId = setInterval(async () => {  
      try {  
        const statusRes = await fetch(`${PAYINAJA_BASE_URL}/api/v1/transaction/${d.payinaja_trx_id}`, {  
          method: "GET",  
          headers: { "x-api-key": PAYINAJA_API_KEY }  
        });  

        const statusData = await statusRes.json();  
        if (statusData.success === true && statusData.data) {  
          const currStatus = statusData.data.status;  

          if (currStatus === "success") {  
            const userCheck = await User.findOne({ _id: user._id, "historyDeposit.id": d.payinaja_trx_id });  
            const txInDb = userCheck?.historyDeposit?.find(tx => tx.id === d.payinaja_trx_id);  

            if (txInDb && txInDb.status !== "success") {  
              await editHistoryDeposit(user._id, d.payinaja_trx_id, "success");  
              await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalBalance } });  
            }  
            clearInterval(intervalId);  
          } else if (["failed", "expired", "cancel"].includes(currStatus)) {  
            await editHistoryDeposit(user._id, d.payinaja_trx_id, currStatus);  
            clearInterval(intervalId);  
          }  
        }  
      } catch (e) {  
        console.error("Polling Error:", e.message);  
      }  
    }, 5000);  

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// === ROUTE CEK STATUS (HANYA RICHMARKET) ===
router.post("/deposit/status", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });
  
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne({ _id: user._id, "historyDeposit.id": id }, { "historyDeposit.$": 1 });
    if (!userHistory) return res.status(404).json({ success: false, message: "Data tidak ditemukan." });

    const localData = userHistory.historyDeposit[0];

    // Cek ke API RichMarket
    const response = await fetch(`${RICH_BASE_URL}/get_status.php?trx_id=${id}`, {
        method: "GET",
        headers: { "X-API-KEY": RICH_API_KEY }
    });
    const result = await response.json();
    
    if (result.status !== "success") return res.status(404).json({ success: false, message: "Data tidak ditemukan di provider." });

    return res.status(200).json({
      success: true,
      data: {
        id: result.data.trx_id,
        status: result.data.payment_status.toLowerCase(),
        nominal: parseInt(result.data.amount),
        // --- PERUBAHAN DISINI: Mengambil fee dari DB yang dihitung berdasarkan ENV ---
        fee: localData.fee || 0,
        get_balance: localData.get_balance || 0,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// === ROUTE CANCEL DEPOSIT (HANYA RICHMARKET) ===
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });
  
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne({ _id: user._id, "historyDeposit.id": id }, { "historyDeposit.$": 1 });
    if (!userHistory) return res.status(404).json({ success: false, message: "Data tidak ditemukan." });

    // Request Pembatalan ke RichMarket
    const richResponse = await fetch(`${RICH_BASE_URL}/cancel_payment.php`, {
      method: "POST",
      headers: {
        "X-API-KEY": RICH_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        trx_id: id // Mengirimkan trx_id sesuai dokumentasi
      })
    });

    const result = await richResponse.json();

    if (result.status !== "success") {
      return res.status(502).json({
        success: false,
        message: result.message || "Gagal membatalkan deposit.",
      });
    }

    // Update status di database internal
    await editHistoryDeposit(user._id, id, "cancel");

    return res.status(200).json({
      success: true,
      data: {
        id: result.data.trx_id,
        status: result.data.new_status.toLowerCase(), // Status baru: "CANCELLED"
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
