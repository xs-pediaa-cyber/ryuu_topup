const express = require("express");
const qs = require("qs");
const cloudscraper = require("cloudscraper");
const router = express.Router();

// KONFIGURASI PROV

const GOREKK_API_KEY = process.env.GOREKK_API_KEY;
const GOREKK_BASE_URL = "https://www.gorekk.web.id/api/v1";


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
    
    // Fee sesuai role (0.5% reseller, 1.0% user)
    const feeDesimal = role === "reseller" ? 0.001 : 0.002;
    const feePersen = (feeDesimal * 100).toString(); 

    const metodeFormatted = [{
      metode: "QRIS",
      type: "ewallet",
      name: "QRIS All Payment (Otomatis)",
      min: 50,
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


// === ROUTE BUAT DEPOSIT (GOREKK API) ===
router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { nominal } = req.query;

  if (!nominal || isNaN(nominal)) {
    return res.status(400).json({ success: false, message: "Nominal tidak valid." });
  }

  const parsedNominal = parseInt(nominal);
  if (parsedNominal < 1) {
    return res.status(400).json({ success: false, message: "Minimal deposit Rp1" });
  }

  try {
    // Request ke Gorekk API (menggunakan parameter URL sesuai dokumentasi)
    const qrisString = "00020101021126610014COM.GO-JEK.WWW01189360091430973426920210G0973426920303UMI51440014ID.CO.QRIS.WWW0215ID10265700401900303UMI5204152053033605802ID5925Toko%20Online%2C%20Konstruksi%20%266009TANGERANG61051512362070703A01630477B4";
    const createUrl = `${GOREKK_BASE_URL}/qris/create?amount=${parsedNominal}&static_qr=${qrisString}&expires_in=60&unique_amount=True`;

    const response = await fetch(createUrl, {
      method: "GET",
      headers: {
        "X-API-Key": GOREKK_API_KEY
      }
    });

    const result = await response.json();    
    if (!result || !result.success) {    
      return res.status(502).json({ success: false, message: result?.message || "Gagal membuat QRIS." });    
    }    

    // KALKULASI ANTI-NaN    
    const nominalAsli = Number(result.amount) || parsedNominal;    
    const totalBayar = Number(result.expected_amount) || nominalAsli;    
    const feeGorekk = 0; // Sesuaikan jika ada fee dari provider
    
    const feePercent = user.role === "reseller" ? 0.001 : 0.002;    
    let additionalFee = Math.ceil(nominalAsli * feePercent);    
    const finalBalance = nominalAsli - additionalFee;    

    const history = {    
      id: result.invoice_id, // Menggunakan invoice_id sebagai ID transaksi unik
      nominal: nominalAsli,    
      fee: additionalFee + feeGorekk,     
      get_balance: finalBalance,    
      metode: "QRIS",    
      status: "pending",    
      qr_image: result.image_url,    
      created_at: new Date(),    
    };    

    // Gunakan fungsi internal kamu    
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

    // POLLING OTOMATIS (Gorekk API Invoice Status)    
    const intervalId = setInterval(async () => {    
      try {    
        const checkRes = await fetch(`${GOREKK_BASE_URL}/qris/invoice?invoice_id=${result.invoice_id}`, {    
          method: "GET",    
          headers: { "X-API-Key": GOREKK_API_KEY }    
        });    
        const statusData = await checkRes.json();    

        if (statusData?.success && statusData.invoice) {    
          const apiStatus = statusData.invoice.status.toLowerCase(); // contoh: "paid", "pending", dll
          
          // Sesuaikan mapping status dari Gorekk (misal 'paid' dianggap setara 'success')
          if (apiStatus === "paid" || apiStatus === "success") {    
            const userCheck = await User.findOne({ _id: user._id, "historyDeposit.id": result.invoice_id });    
            const txInDb = userCheck?.historyDeposit?.find(tx => tx.id === result.invoice_id);    

            if (txInDb && txInDb.status !== "success") {    
              await editHistoryDeposit(user._id, result.invoice_id, "success");    
              await User.findByIdAndUpdate(user._id, { $inc: { saldo: finalBalance } });    
            }    
            clearInterval(intervalId);    
          } else if (["failed", "expired", "cancel", "cancelled"].includes(apiStatus)) {    
            await editHistoryDeposit(user._id, result.invoice_id, apiStatus);    
            clearInterval(intervalId);    
          }    
        }    
      } catch (e) { clearInterval(intervalId); }    
    }, 10000);

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// === ROUTE CEK STATUS (GOREKK API) ===
router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { id } = req.query; // Di sini 'id' adalah invoice_id
  const { user } = req;
  
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne({ _id: user._id, "historyDeposit.id": id }, { "historyDeposit.$": 1 });
    if (!userHistory) return res.status(404).json({ success: false, message: "Data tidak ditemukan di DB." });

    const localData = userHistory.historyDeposit[0];    

    // Cek ke API Gorekk via endpoint invoice
    const response = await fetch(`${GOREKK_BASE_URL}/qris/invoice?invoice_id=${id}`, {    
        method: "GET",    
        headers: { "X-API-Key": GOREKK_API_KEY }    
    });    
    const result = await response.json();    
        
    if (!result.success || !result.invoice) {    
      return res.status(404).json({ success: false, message: "Data tidak ditemukan di provider." });    
    }    

    const invoiceData = result.invoice;
    const apiStatus = invoiceData.status.toLowerCase(); 
    
    // Update status jika sudah sukses/paid di provider tapi masih pending di DB    
    if ((apiStatus === "paid" || apiStatus === "success") && localData.status !== "success") {    
        await editHistoryDeposit(user._id, id, "success");    
        await User.findByIdAndUpdate(user._id, { $inc: { saldo: Number(localData.get_balance) || 0 } });    
    }    

    return res.status(200).json({    
      success: true,    
      data: {    
        id: id,    
        status: apiStatus === "paid" ? "success" : apiStatus,    
        nominal: Number(invoiceData.amount),    
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

router.get('/am/verify', verifyApiKey, async (req,res)=>{
try{

const {email,link}=req.query;


if(!email || !link){
return res.json({
status:false,
message:"Email dan link wajib diisi"
});
}



const apiURL =
`https://api.xs-pedia.my.id/am/verify`+
`?email=${encodeURIComponent(email)}`+
`&link=${encodeURIComponent(link)}`+
`&apikey=free`;



const response = await fetch(apiURL);


const data = await response.json();



return res.json({

status:data.status,
creator:"@RyuuXiao",
source:"xs-pedia",
endpoint:"am/verify",
message:data.message,
data:data.data

});



}catch(err){

console.log(err);

res.status(500).json({
status:false,
message:"Internal server error"
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

module.exports = router;
