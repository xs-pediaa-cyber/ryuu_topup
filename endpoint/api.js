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

    // Menggunakan path lokal file background kustom di server
    const customBgUrl = `${req.protocol}://${req.get('host')}/media/bg.jpg`;

    const history = {
      id: payData.payinaja_trx_id,
      nominal: nominalAsli,
      fee: additionalFee + feePayinaja, 
      get_balance: finalBalance,
      metode: "QRIS",
      status: "pending",
      qr_image: payData.qris_image_url,
      qris_string: payData.qris_string || payData.qris || "",
      bg_image: customBgUrl,
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
        qris_string: history.qris_string,
        bg_image: customBgUrl, // URL background lokal dikirim ke frontend
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

// Middleware validasi API Key langsung dengan string "free"
const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers['x-apikey'] || req.query.apikey;
  if (!apiKey || apiKey !== "free") {
    return res.status(401).json({
      status: false,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      message: "API Key tidak valid atau tidak ditemukan! Gunakan 'free'."
    });
  }
  next();
};

// ==========================================
// ENDPOINT TAHAP 1: KIRIM EMAIL (/am/send)
// ==========================================
router.get('/send', verifyApiKey, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        status: false,
        creator: "@RyuuXiao",
        source: "xs-pedia",
        endpoint: "send",
        message: "Parameter 'email' wajib diisi!"
      });
    }

    console.log(`[AM SEND] Mengirim link verifikasi ke: ${email}`);

    return res.status(200).json({
      status: true,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "send",
      message: "Link verifikasi berhasil dikirim.",
      data: {
        email: email,
        upstream: {
          creator: "Blckrosé",
          status: true,
          message: "Link verifikasi berhasil dikirim ke email",
          data: {
            type: "need_link",
            email: email
          }
        }
      }
    });

  } catch (err) {
    console.error("Error pada /am/send:", err);
    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});

// ==========================================
// ENDPOINT TAHAP 2: VERIFIKASI LINK (/am/verify)
// ==========================================
router.get('/verify', verifyApiKey, async (req, res) => {
  try {
    const { email, link } = req.query;

    if (!email || !link) {
      return res.status(400).json({
        status: false,
        creator: "@RyuuXiao",
        source: "xs-pedia",
        endpoint: "verify",
        message: "Parameter 'email' dan 'link' wajib diisi!"
      });
    }

    console.log(`[AM VERIFY] Memproses verifikasi email: ${email} dengan link: ${link}`);

    return res.status(200).json({
      status: true,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "verify",
      message: "Link berhasil diverifikasi.",
      data: {
        email: email,
        link: link,
        upstream: {
          creator: "Blckrosé",
          status: true,
          message: "Verifikasi berhasil! Akun premium aktif.",
          data: {
            type: "success",
            email: email,
            duration: "1_year"
          }
        }
      }
    });

  } catch (err) {
    console.error("Error pada /am/verify:", err);
    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});


module.exports = router;
