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

// === ROUTE DAFTAR METODE (HANYA PAYINAJA QRIS) ===
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    // Fee persen untuk tampilan diambil dari .env (dikonversi ke string untuk frontend jika diperlukan)
    let feePersen = role === "reseller" 
      ? (process.env.FEE_PERCENT_RESELLER || "2.5") 
      : (process.env.FEE_PERCENT_USER || "5.5");  

    // MENGEMBALIKAN METODE PAYINAJA QRIS  
    const metodeFormatted = [{  
      metode: "QRIS",  
      type: "ewallet",  
      name: "QRIS All Payment (Otomatis)",  
      min: 500,  
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
    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal);

    if (!nominal || isNaN(parsedNominal) || parsedNominal < 500) {
      return res.status(400).json({ success: false, message: "Minimal deposit Rp500" });
    }

    const API_KEY = process.env.PAYINAJA_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ success: false, message: "API Key Payinaja belum disetting di server." });
    }

    let response;
    try {
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
          customer_name: user.username || "User"
        })
      });
    } catch (fetchError) {
      console.error("Fetch API Error:", fetchError);
      return res.status(502).json({ success: false, message: "Koneksi server ke Payinaja gagal/diblokir." });
    }

    const result = await response.json();
    
    if (!result || !result.success) {
      return res.status(400).json({ 
        success: false, 
        message: result.message || "Gagal ke Payinaja (Cek kembali pengaturan akun/nominal)" 
      });
    }

    const payData = result.data;

    // --- KALKULASI FEE ---
    // Fee provider = biaya admin asli dari Payinaja.
    // Fee ENV = pajak/biaya tambahan yang dibebankan ke pembayaran.
    // Keduanya digabung lalu ditambahkan ke nominal. Saldo user tetap sebesar nominal deposit.
    const nominalAsli = Number(payData.amount_requested) || parsedNominal;

    const providerFeeRaw = Number(payData.fee);
    const providerTotalRaw = Number(payData.total_amount);
    const feeProvider = Number.isFinite(providerFeeRaw) && providerFeeRaw >= 0
      ? Math.ceil(providerFeeRaw)
      : (
          Number.isFinite(providerTotalRaw) && providerTotalRaw > nominalAsli
            ? Math.ceil(providerTotalRaw - nominalAsli)
            : 0
        );

    const feePercentUser = parseFloat(process.env.FEE_PERCENT_USER);
    const feePercentReseller = parseFloat(process.env.FEE_PERCENT_RESELLER);

    let additionalFee = 0;
    if (user.role === "reseller") {
        const pct = Number.isFinite(feePercentReseller) ? feePercentReseller : 2.5;
        additionalFee = Math.ceil(nominalAsli * (pct / 100));
    } else {
        const pct = Number.isFinite(feePercentUser) ? feePercentUser : 5.5;
        additionalFee = Math.ceil(nominalAsli * (pct / 100));
    }

    // Total biaya = admin provider + pajak/fee ENV.
    // Total pembayaran = nominal deposit + seluruh fee.
    // Saldo diterima = nominal deposit utuh.
    const totalFee = Math.max(0, feeProvider + additionalFee);
    const totalBayar = Math.max(0, Math.ceil(nominalAsli + totalFee));
    const finalGetBalance = Math.max(0, Math.floor(nominalAsli));

    // Menggunakan URL background baru dari Catbox secara aman
    const customBgUrl = "https://files.catbox.moe/sh2bcj.png";

    const historyDataForDb = {
      id: payData.payinaja_trx_id,
      nominal: nominalAsli,
      fee: totalFee,
      get_balance: finalGetBalance,
      metode: "QRIS",
      status: "pending",
      qr_image: payData.qris_image_url,
      qris_string: payData.qris_string || payData.qris || "",
      bg_image: customBgUrl,
      created_at: new Date(),
    };

    await tambahHistoryDeposit(user._id, historyDataForDb);

    res.status(200).json({
      success: true,
      data: {
        id: payData.payinaja_trx_id,
        trx_id: payData.payinaja_trx_id,
        metode: "QRIS",
        nominal: nominalAsli,
        fee: totalFee,
        total_amount: totalBayar,
        get_balance: finalGetBalance,
        qr_image: payData.qris_image_url,
        qris_string: payData.qris_string || payData.qris || "",
        bg_image: customBgUrl, 
        status: "pending"
      }
    });

    // POLLING: Setiap 1 menit (60000 ms)
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
        const checkData = await checkRes.json();
        
        const latestHistory = await User.findOne(
          { _id: user._id, "historyDeposit.id": payData.payinaja_trx_id },
          { "historyDeposit.$": 1 }
        );
        const latestDeposit = latestHistory?.historyDeposit?.[0];

        // Status terminal lokal (terutama "cancel") tidak boleh ditimpa provider.
        if (!latestDeposit || !["pending", "processing"].includes(String(latestDeposit.status || "").toLowerCase())) {
          clearInterval(intervalId);
          return;
        }

        const providerStatus = String(checkData?.data?.status || "").toLowerCase();
        if (checkData?.success && providerStatus === "success") {
          await editHistoryDeposit(user._id, payData.payinaja_trx_id, "success");
          await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalGetBalance } });
          clearInterval(intervalId);
        } else if (["failed", "expired", "cancel"].includes(providerStatus)) {
          await editHistoryDeposit(user._id, payData.payinaja_trx_id, providerStatus);
          clearInterval(intervalId);
        }
      } catch (e) { 
        console.error("Polling Error:", e.message); 
      }
    }, 60000);

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// === ROUTE CEK STATUS (ANTI-NaN & SYNC) ===
router.post("/deposit/status", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });
  
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userWithHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id }, 
      { "historyDeposit.$": 1 }
    );
    
    if (!userWithHistory || !userWithHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan." });
    }

    let localData = userWithHistory.historyDeposit[0];
    const localStatus = String(localData.status || "pending").toLowerCase();

    // Status terminal yang sudah disimpan di DB adalah sumber kebenaran.
    // Ini mencegah "cancel" berubah kembali menjadi "pending" karena provider belum sync.
    if (!["pending", "processing"].includes(localStatus)) {
      return res.status(200).json({
        success: true,
        data: {
          id: id,
          trx_id: id,
          reff_id: localData.reff_id || "-",
          nominal: Number(localData.nominal) || 0,
          total_amount: Math.max(0, (Number(localData.nominal) || 0) + (Number(localData.fee) || 0)),
          fee: Number(localData.fee) || 0,
          get_balance: Number(localData.get_balance) || 0,
          status: localStatus,
          metode: localData.metode || "QRIS",
          qr_image: localData.qr_image || null,
          created_at: localData.created_at || null
        }
      });
    }

    const API_KEY = process.env.PAYINAJA_API_KEY;
    const response = await fetch(`https://payinaja.com/api/v1/transaction/${id}`, {
        method: "GET",
        headers: { "x-api-key": API_KEY }
    });

    const result = await response.json();
    const providerStatus = String(result?.data?.status || localStatus).toLowerCase();
    let effectiveStatus = localStatus;

    if (providerStatus === "success" && ["pending", "processing"].includes(localStatus)) {
        await User.updateOne(
            { _id: user._id, "historyDeposit.id": id },
            {
                $set: { "historyDeposit.$.status": "success" },
                $inc: { saldo: Number(localData.get_balance) || 0 }
            }
        );
        effectiveStatus = "success";
    } else if (["failed", "expired", "cancel"].includes(providerStatus)) {
        await User.updateOne(
            { _id: user._id, "historyDeposit.id": id },
            { $set: { "historyDeposit.$.status": providerStatus } }
        );
        effectiveStatus = providerStatus;
    }

    // Ambil ulang history agar status dan tanggal yang dikembalikan selalu yang terbaru.
    const refreshedUser = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );
    localData = refreshedUser?.historyDeposit?.[0] || localData;
    effectiveStatus = String(localData.status || effectiveStatus).toLowerCase();

    const nominal = Number(localData.nominal) || Number(result?.data?.amount_requested) || 0;
    const fee = Number(localData.fee) || 0;

    return res.status(200).json({
      success: true,
      data: {
        id: id,
        trx_id: id,
        reff_id: localData.reff_id || "-",
        nominal: nominal,
        total_amount: Math.max(0, nominal + fee),
        fee: fee,
        get_balance: Number(localData.get_balance) || 0,
        status: effectiveStatus,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || result?.data?.qris_image_url || null,
        created_at: localData.created_at || null
      }
    });

  } catch (error) {
    console.error("Error Status Check:", error);
    res.status(500).json({ success: false, message: "Gagal memuat detail terbaru." });
  }
});

// === ROUTE CANCEL DEPOSIT (INTERNAL ONLY) ===
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });
  
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id }, 
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data transaksi tidak ditemukan." });
    }

    const currentData = userHistory.historyDeposit[0];

    if (currentData.status !== "pending") {
      return res.status(400).json({ 
        success: false, 
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.` 
      });
    }

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
