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

//=== ROUTE DAFTAR METODE (HANYA PAYINAJA QRIS) ===
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

    const nominalAsli = Number(payData.amount_requested) || parsedNominal;
    const feePayinaja = Number(payData.fee) || 0;
    
    let additionalFee = 0;
    if (user.role === "user") {
        additionalFee = Math.ceil(nominalAsli * 0.002);
    } else if (user.role === "reseller") {
        additionalFee = Math.ceil(nominalAsli * 0.001);
    }

    const totalBayar = Math.ceil(Number(payData.total_amount) || (nominalAsli + feePayinaja));
    const totalFee = feePayinaja + additionalFee;
    const finalGetBalance = nominalAsli - additionalFee;

    // Membuat link URL dinamis untuk file background kustom lokal (bg.jpg)
    const customBgUrl = `${req.protocol}://${req.get('host')}/media/bg.jpg`;

    const historyDataForDb = {
      id: payData.payinaja_trx_id,
      nominal: nominalAsli,
      fee: totalFee,
      get_balance: finalGetBalance,
      metode: "QRIS",
      status: "pending",
      qr_image: payData.qris_image_url,
      qris_string: payData.qris_string || payData.qris || "",
      bg_image: customBgUrl, // Disimpan ke riwayat database
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
        bg_image: customBgUrl, // Dikirim langsung ke response frontend
        status: "pending"
      }
    });

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
        
        if (checkData?.success && checkData.data?.status.toLowerCase() === "success") {
          await editHistoryDeposit(user._id, payData.payinaja_trx_id, "success");
          await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalGetBalance } });
          clearInterval(intervalId);
        } else if (checkData?.data && ["failed", "expired", "cancel"].includes(checkData.data.status.toLowerCase())) {
          await editHistoryDeposit(user._id, payData.payinaja_trx_id, checkData.data.status.toLowerCase());
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
    // 1. Ambil data dari database lokal
    const userWithHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id }, 
      { "historyDeposit.$": 1 }
    );
    
    if (!userWithHistory || !userWithHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan." });
    }

    const localData = userWithHistory.historyDeposit[0];
    const API_KEY = process.env.PAYINAJA_API_KEY;

    // 2. Ambil data terbaru dari Payinaja
    const response = await fetch(`https://payinaja.com/api/v1/transaction/${id}`, {
        method: "GET",
        headers: { "x-api-key": API_KEY }
    });
    
    const result = await response.json();
    
    // Default data jika provider gagal memberikan respon lengkap
    const statusProvider = result?.data?.status?.toLowerCase() || localData.status;

    // 3. Sinkronisasi Saldo Otomatis jika status sukses
    if (statusProvider === "success" && localData.status === "pending") {
        await User.updateOne(
            { _id: user._id, "historyDeposit.id": id },
            { 
                $set: { "historyDeposit.$.status": "success" },
                $inc: { saldo: Number(localData.get_balance) || 0 }
            }
        );
    }

    // 4. RESPONSE KE FRONTEND (Pastikan menggunakan Number() untuk mencegah NaN)
    return res.status(200).json({
      success: true,
      data: {
        id: id,
        trx_id: id,
        // Pastikan nominal diambil dari DB lokal jika provider NaN
        nominal: Number(result?.data?.amount_requested) || Number(localData.nominal) || 0,
        total_amount: Number(result?.data?.total_amount) || (Number(localData.nominal) + Number(localData.fee)) || 0,
        fee: Number(localData.fee) || 0,
        get_balance: Number(localData.get_balance) || 0,
        status: statusProvider,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || result?.data?.qris_image_url
      }
    });

  } catch (error) {
    console.error("Error Status Check:", error);
    // Jika error, kirimkan data lokal saja agar tidak tampilan NaN
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
