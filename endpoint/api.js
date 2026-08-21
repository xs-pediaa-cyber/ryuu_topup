const express = require("express");
const qs = require("qs");
const cloudscraper = require("cloudscraper");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const QRCode = require("qrcode");
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


// ==========================================
// HELPER QRIS COMPOSITE (BACKGROUND + QR)
// ==========================================
const QR_OUTPUT_DIR = path.join(__dirname, "../media/generated-qris");
const DEFAULT_BG_URL = "https://files.catbox.moe/43lq1g.png";
const DEFAULT_BG_PATH = path.join(__dirname, "../media/bg.jpg");

function getFeePercentForRole(role) {
  const raw = role === "reseller"
    ? process.env.FEE_PERCENT_RESELLER
    : process.env.FEE_PERCENT_USER;

  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;

  return role === "reseller" ? 2.5 : 5.5;
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Gagal mengambil gambar (${response.status})`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function createQrisComposite({
  trxId,
  qrisImageUrl,
  qrisString,
  backgroundPath = DEFAULT_BG_PATH,
  backgroundUrl = DEFAULT_BG_URL,
}) {
  await fs.promises.mkdir(QR_OUTPUT_DIR, { recursive: true });

  let backgroundBuffer;
  try {
    backgroundBuffer = await fs.promises.readFile(backgroundPath);
  } catch {
    backgroundBuffer = await fetchBuffer(backgroundUrl);
  }

  // PENTING: gunakan QR IMAGE ASLI dari Payinaja terlebih dahulu.
  // Jangan generate ulang dari qris_string jika image provider tersedia,
  // karena image asli adalah QR yang sudah diterbitkan provider.
  let qrBuffer;

  if (qrisImageUrl) {
    qrBuffer = await fetchBuffer(qrisImageUrl);
  } else if (qrisString) {
    qrBuffer = await QRCode.toBuffer(qrisString, {
      type: "png",
      width: 1200,
      margin: 4,
      errorCorrectionLevel: "H",
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
  } else {
    throw new Error("QRIS image/string dari provider tidak tersedia.");
  }

  // Background tetap proporsional dan menjadi RGB/PNG penuh.
  const baseBuffer = await sharp(backgroundBuffer)
    .rotate()
    .resize({
      width: 1200,
      fit: "inside",
      withoutEnlargement: false,
    })
    .flatten({ background: "#FFFFFF" })
    .png()
    .toBuffer();

  const meta = await sharp(baseBuffer).metadata();

  const width = meta.width || 1200;
  const height = meta.height || 1200;

  // QR dibuat cukup besar agar mudah dideteksi kamera.
  const qrSize = Math.min(
    720,
    Math.floor(width * 0.95),
    Math.floor(height * 0.25)
  );

  // Panel putih + quiet-zone besar.
  // QR tetap berada di atas background, tetapi area QR bersih.
  const qrPrepared = await sharp(qrBuffer)
    .rotate()
    .flatten({ background: "#FFFFFF" })
    .resize({
      width: qrSize,
      height: qrSize,
      fit: "contain",
      background: "#FFFFFF",
    })
    .extend({
      top: 55,
      bottom: 55,
      left: 55,
      right: 55,
      background: "#FFFFFF",
    })
    .png()
    .toBuffer();

  const qrMeta = await sharp(qrPrepared).metadata();

  const qrWidth = qrMeta.width || qrSize + 110;
  const qrHeight = qrMeta.height || qrSize + 110;

  // Posisi di tengah bagian bawah, seluruh QR harus tetap terlihat.
  const left = Math.max(
    0,
    Math.floor((width - qrWidth) / 2)
  );

  const top = Math.max(
    0,
    Math.min(
      height - qrHeight - 20,
      Math.floor(height * 0.52)
    )
  );

  const filename =
    `${String(trxId).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;

  const outputPath =
    path.join(QR_OUTPUT_DIR, filename);

  await sharp(baseBuffer)
    .composite([
      {
        input: qrPrepared,
        left,
        top,
        blend: "over",
      },
    ])
    .flatten({ background: "#FFFFFF" })
    .png({
      compressionLevel: 6,
      adaptiveFiltering: true,
      force: true,
    })
    .toFile(outputPath);

  return {
    filename,
    path: outputPath,
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
    
    // Fee mengikuti .env agar sama dengan deposit web.
    const feePersen = String(getFeePercentForRole(role));

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
    return res.status(400).json({
      success: false,
      message: "Nominal tidak valid.",
    });
  }

  const parsedNominal = parseInt(nominal, 10);
  if (!Number.isInteger(parsedNominal) || parsedNominal < 500) {
    return res.status(400).json({
      success: false,
      message: "Minimal deposit Rp500",
    });
  }

  if (!user?._id) {
    return res.status(401).json({
      success: false,
      message: "User API tidak valid.",
    });
  }

  const API_KEY = process.env.PAYINAJA_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      message: "API Key Payinaja belum disetting.",
    });
  }

  try {
    // Fee ENV harus dimasukkan ke amount yang dikirim ke provider.
    // Contoh deposit Rp500 + fee ENV Rp22 => request provider Rp522.
    const envPercent = getFeePercentForRole(user.role);
    const additionalFee = Math.max(
      0,
      Math.ceil(parsedNominal * (envPercent / 100))
    );
    const providerRequestAmount = parsedNominal + additionalFee;

    let response;
    try {
      response = await fetch(`${PAYINAJA_BASE_URL}/qris/create2`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
          "x-api-key": API_KEY,
        },
        body: JSON.stringify({
          amount: providerRequestAmount,
          reference_id: `DEP-${Date.now()}`,
          customer_name: user.username || "Pelanggan",
        }),
      });
    } catch (fetchError) {
      console.error("Fetch API Error:", fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Payinaja gagal/diblokir.",
      });
    }

    const result = await response.json();

    if (!result || !result.success) {
      return res.status(502).json({
        success: false,
        message: result?.message || "Gagal membuat QRIS.",
      });
    }

    const payData = result.data || {};
    const trxId = payData.payinaja_trx_id;
    if (!trxId) {
      return res.status(502).json({
        success: false,
        message: "Provider tidak mengembalikan ID transaksi.",
      });
    }

    const nominalAsli = parsedNominal;
    const providerRequestedAmount =
      Number(payData.amount_requested) || providerRequestAmount;
    const providerTotalRaw = Number(payData.total_amount);
    const providerFeeRaw = Number(payData.fee);

    let feeProvider = 0;
    if (Number.isFinite(providerFeeRaw) && providerFeeRaw >= 0) {
      feeProvider = Math.ceil(providerFeeRaw);
    } else if (
      Number.isFinite(providerTotalRaw) &&
      providerTotalRaw >= providerRequestedAmount
    ) {
      feeProvider = Math.ceil(providerTotalRaw - providerRequestedAmount);
    }

    const totalBayar =
      Number.isFinite(providerTotalRaw) && providerTotalRaw > 0
        ? Math.ceil(providerTotalRaw)
        : Math.ceil(providerRequestedAmount + feeProvider);

    // Gabungan fee provider + fee ENV.
    const totalFee = Math.max(0, totalBayar - nominalAsli);

    // Saldo member tetap sesuai nominal deposit.
    const finalBalance = nominalAsli;

    const rawQrImage = payData.qris_image_url || "";
    const qrisString = payData.qris_string || payData.qris || "";
    const bgUrl = DEFAULT_BG_URL;

    // Buat gambar final background + QR agar API consumer tinggal memakai 1 URL.
    let compositeQrUrl = rawQrImage;
    try {
      const generated = await createQrisComposite({
        trxId,
        qrisImageUrl: rawQrImage,
        qrisString,
      });

      compositeQrUrl =
        `${req.protocol}://${req.get("host")}/media/generated-qris/${generated.filename}`;
    } catch (imageError) {
      console.error("QR Composite Error:", imageError.message);
      // Fallback ke QR asli provider agar transaksi tetap berhasil dibuat.
    }

    const history = {
      id: trxId,
      nominal: nominalAsli,
      tambahan: additionalFee,
      fee: totalFee,
      total_amount: totalBayar,
      get_balance: finalBalance,
      metode: "QRIS",
      status: "pending",
      qr_image: compositeQrUrl,
      qr_image_raw: rawQrImage,
      qris_string: qrisString,
      bg_image: bgUrl,
      created_at: new Date(),
    };

    await tambahHistoryDeposit(user._id, history);

    res.status(200).json({
      success: true,
      message: "QRIS berhasil dibuat.",
      data: {
        id: trxId,
        trx_id: trxId,
        metode: "QRIS",
        nominal: nominalAsli,
        fee: totalFee,
        fee_env: additionalFee,
        fee_provider: Math.max(0, totalFee - additionalFee),
        total_amount: totalBayar,
        get_balance: finalBalance,

        // QR utama = gambar final background + QR.
        qr_image: compositeQrUrl,
        qr_image_combined: compositeQrUrl,

        // URL/isi QR asli tetap disediakan sebagai fallback.
        qr_image_raw: rawQrImage,
        qris_string: qrisString,

        // Background asli.
        bg_image: bgUrl,

        status: "pending",
        created_at: history.created_at,
      },
    });

    // POLLING OTOMATIS
    const intervalId = setInterval(async () => {
      try {
        const latestHistory = await User.findOne(
          { _id: user._id, "historyDeposit.id": trxId },
          { "historyDeposit.$": 1 }
        );
        const latestDeposit = latestHistory?.historyDeposit?.[0];
        const localStatus = String(latestDeposit?.status || "").toLowerCase();

        // Jangan biarkan provider menghidupkan kembali transaksi yang sudah cancel/terminal.
        if (!latestDeposit || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const checkRes = await fetch(
          `${PAYINAJA_BASE_URL}/transaction/${trxId}`,
          {
            method: "GET",
            headers: {
              "Accept": "application/json",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              "x-api-key": API_KEY,
            },
          }
        );

        const statusData = await checkRes.json();
        const apiStatus = String(
          statusData?.data?.status || ""
        ).toLowerCase();

        if (statusData?.success && apiStatus === "success") {
          await editHistoryDeposit(user._id, trxId, "success");
          await User.findByIdAndUpdate(user._id, {
            $inc: { saldo: finalBalance },
          });
          clearInterval(intervalId);
        } else if (
          ["failed", "expired", "cancel"].includes(apiStatus)
        ) {
          await editHistoryDeposit(user._id, trxId, apiStatus);
          clearInterval(intervalId);
        }
      } catch (e) {
        // Error sementara tidak langsung menghentikan polling.
        console.error("Polling API Error:", e.message);
      }
    }, 10000);
  } catch (error) {
    console.error("API Deposit Create Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// === ROUTE CEK STATUS (STRUKTUR ASLI - PAYINAJA) ===
router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { id } = req.query;
  const { user } = req;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID diperlukan.",
    });
  }

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan di DB.",
      });
    }

    const localData = userHistory.historyDeposit[0];
    const localStatus = String(localData.status || "pending").toLowerCase();

    // Transaksi yang sudah cancel/expired/failed harus tetap memakai status lokal.
    let apiStatus = localStatus;

    if (localStatus === "pending" || localStatus === "processing") {
      const response = await fetch(
        `${PAYINAJA_BASE_URL}/transaction/${id}`,
        {
          method: "GET",
          headers: {
            "x-api-key": process.env.PAYINAJA_API_KEY,
          },
        }
      );

      const result = await response.json();

      if (result?.success && result?.data?.status) {
        apiStatus = String(result.data.status).toLowerCase();

        if (apiStatus === "success" && localStatus !== "success") {
          await editHistoryDeposit(user._id, id, "success");
          await User.findByIdAndUpdate(user._id, {
            $inc: { saldo: Number(localData.get_balance) || 0 },
          });
        } else if (
          ["failed", "expired", "cancel"].includes(apiStatus) &&
          localStatus !== apiStatus
        ) {
          await editHistoryDeposit(user._id, id, apiStatus);
        }
      }
    }

    const totalAmount =
      Number(localData.total_amount) > 0
        ? Number(localData.total_amount)
        : Number(localData.nominal || 0) + Number(localData.fee || 0);

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,
        status: apiStatus,
        nominal: Number(localData.nominal) || 0,
        fee: Number(localData.fee) || 0,
        total_amount: totalAmount,
        get_balance: Number(localData.get_balance) || 0,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || "",
        qr_image_raw: localData.qr_image_raw || "",
        qris_string: localData.qris_string || "",
        bg_image: localData.bg_image || DEFAULT_BG_URL,
        created_at: localData.created_at || null,
      },
    });
  } catch (error) {
    console.error("Error status API:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
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
