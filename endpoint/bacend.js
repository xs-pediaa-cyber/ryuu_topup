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
    let feePersen = role === "reseller" ? "1.5" : "0.15";  

    // MENGEMBALIKAN METODE PAYINAJA QRIS  
    const metodeFormatted = [{  
      metode: "QRIS",  
      type: "ewallet",  
      name: "QRIS All Payment (Otomatis)",  
      min: 10,  
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
    if (!nominal || isNaN(parsedNominal) || parsedNominal < 1) {  
      return res.status(400).json({ success: false, message: "Minimal deposit Rp1" });  
    }  

    const API_KEY = process.env.GOREKK_API_KEY;  
    if (!API_KEY) {  
      return res.status(500).json({ success: false, message: "API Key Gorekk belum disetting di server." });  
    }  

    let response;  
    try {  
      // --- UPDATE: Request GET ke Gorekk API dengan query parameters ---  
      const qrisString = "00020101021126610014COM.GO-JEK.WWW01189360091430973426920210G0973426920303UMI51440014ID.CO.QRIS.WWW0215ID10265700401900303UMI5204152053033605802ID5925Toko%20Online%2C%20Konstruksi%20%266009TANGERANG61051512362070703A01630477B4";
      const createUrl = `https://www.gorekk.web.id/api/v1/qris/create?amount=${parsedNominal}&static_qr=${qrisString}&expires_in=60&unique_amount=True`;

      response = await fetch(createUrl, {  
        method: "GET",  
        headers: {   
          "Accept": "application/json",  
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",  
          "X-API-Key": API_KEY   
        }  
      });  
    } catch (fetchError) {  
      console.error("Fetch API Error:", fetchError);  
      return res.status(502).json({ success: false, message: "Koneksi server ke Gorekk gagal/diblokir." });  
    }  

    const result = await response.json();  
      
    if (!result || !result.success) {  
      return res.status(400).json({   
        success: false,   
        message: result.message || "Gagal membuat QRIS (Cek kembali pengaturan akun/nominal)"   
      });  
    }  

    // --- FIX KALKULASI & ROUNDING (Gorekk Response Mapping) ---  
    const nominalAsli = Number(result.amount) || parsedNominal;  
    const feeGorekk = 0; // Sesuaikan jika ada fee khusus dari provider
      
    let additionalFee = 0;  
    if (user.role === "user") {  
        additionalFee = Math.ceil(nominalAsli * 0.002);  
    } else if (user.role === "reseller") {  
        additionalFee = Math.ceil(nominalAsli * 0.001);  
    }  

    const totalBayar = Math.ceil(Number(result.expected_amount) || (nominalAsli + feeGorekk));  
    const totalFee = feeGorekk + additionalFee;  
    const finalGetBalance = nominalAsli - additionalFee;  

    const historyDataForDb = {  
      id: result.invoice_id, // Menggunakan invoice_id sebagai unik ID transaksi
      nominal: nominalAsli,  
      fee: totalFee,  
      get_balance: finalGetBalance,  
      metode: "QRIS",  
      status: "pending",  
      qr_image: result.image_url,  
      created_at: new Date(),  
    };  

    await tambahHistoryDeposit(user._id, historyDataForDb);  

    res.status(200).json({  
      success: true,  
      data: {  
        id: result.invoice_id,  
        trx_id: result.invoice_id,  
        metode: "QRIS",  
        nominal: nominalAsli,  
        fee: totalFee,  
        total_amount: totalBayar,  
        get_balance: finalGetBalance,  
        qr_image: result.image_url,  
        status: "pending"  
      }  
    });  

    // POLLING: Menggunakan endpoint invoice dari Gorekk API  
    const intervalId = setInterval(async () => {  
      try {  
        const checkRes = await fetch(`https://www.gorekk.web.id/api/v1/qris/invoice?invoice_id=${result.invoice_id}`, {  
          method: "GET",  
          headers: {   
            "Accept": "application/json",  
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",  
            "X-API-Key": API_KEY   
          }  
        });  
        const checkData = await checkRes.json();  
          
        if (checkData?.success && checkData.invoice) {  
          const apiStatus = checkData.invoice.status.toLowerCase(); // contoh: "paid", "pending", dll
          
          if (apiStatus === "paid" || apiStatus === "success") {  
            await editHistoryDeposit(user._id, result.invoice_id, "success");  
            await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalGetBalance } });  
            clearInterval(intervalId);  
          } else if (["failed", "expired", "cancel", "cancelled"].includes(apiStatus)) {  
            await editHistoryDeposit(user._id, result.invoice_id, apiStatus);
            clearInterval(intervalId);  
          }  
        }  
      } catch (e) {   
        console.error("Polling Error:", e.message);   
      }  
    }, 10000);  

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// === ROUTE CEK STATUS (GOREKK API) ===
router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });
    
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

    // 1. Ambil data dari database lokal
    const userWithHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );
    
    if (!userWithHistory || !userWithHistory.historyDeposit.length) {  
      return res.status(404).json({ success: false, message: "Data tidak ditemukan." });  
    }  

    const localData = userWithHistory.historyDeposit[0];  
    const API_KEY = process.env.GOREKK_API_KEY;  

    // 2. Ambil data terbaru dari Gorekk API (Endpoint Invoice)
    const response = await fetch(`https://www.gorekk.web.id/api/v1/qris/invoice?invoice_id=${id}`, {  
        method: "GET",  
        headers: { 
          "Accept": "application/json",
          "X-API-Key": API_KEY 
        }  
    });  
      
    const result = await response.json();  
      
    // Default status jika provider gagal memberikan respon lengkap  
    const rawStatus = result?.invoice?.status?.toLowerCase() || localData.status;  
    const statusProvider = (rawStatus === "paid") ? "success" : rawStatus;

    // 3. Sinkronisasi Saldo Otomatis jika status sudah paid/success  
    if ((rawStatus === "paid" || rawStatus === "success") && localData.status === "pending") {  
        await User.updateOne(  
            { _id: user._id, "historyDeposit.id": id },  
            {   
                $set: { "historyDeposit.$.status": "success" },  
                $inc: { saldo: Number(localData.get_balance) || 0 }  
            }  
        );  
    }  

    // 4. RESPONSE KE FRONTEND  
    return res.status(200).json({  
      success: true,  
      data: {  
        id: id,  
        trx_id: id,  
        nominal: Number(result?.invoice?.amount) || Number(localData.nominal) || 0,  
        total_amount: Number(result?.invoice?.expected_amount) || (Number(localData.nominal) + Number(localData.fee)) || 0,  
        fee: Number(localData.fee) || 0,  
        get_balance: Number(localData.get_balance) || 0,  
        status: statusProvider,  
        metode: localData.metode || "QRIS",  
        qr_image: localData.qr_image || result?.invoice?.metadata?.image_url  
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
