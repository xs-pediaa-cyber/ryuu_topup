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
    700,
    Math.floor(width * 0.95),
    Math.floor(height * 0.20)
  );

  // jPanel putih + quiet-zone besar.
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
      Math.floor(height * 0.41)
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
      min: 10,
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
// ================= XS-PEDIA HELPER =================
const XS_PEDIA_BASE_URL = process.env.XS_PEDIA_BASE_URL || "https://xs-pedia-payment.vercel.app";
const XS_PEDIA_TOKEN = process.env.XS_PEDIA_TOKEN;
const XS_PEDIA_STATIC_QR = process.env.XS_PEDIA_STATIC_QR;

async function getXsHistory() {
  if (!XS_PEDIA_TOKEN) throw new Error("XS_PEDIA_TOKEN belum disetting.");
  const r = await fetch(`${XS_PEDIA_BASE_URL}/api/history?token=${encodeURIComponent(XS_PEDIA_TOKEN)}`, {
    headers: { Accept: "application/json" }
  });
  const d = await r.json();
  if (!r.ok || !d?.success) throw new Error(d?.message || "Gagal mengambil history XS-Pedia.");
  return Array.isArray(d.data) ? d.data : [];
}

function findXsTransaction(list, amount, createdAt) {
  const a = Number(amount);
  const t = new Date(createdAt).getTime();
  return list
    .filter(x => Number(x.amount) === a)
    .filter(x => {
      const xt = new Date(x.time).getTime();
      return Number.isFinite(xt) && xt >= t - 2 * 60 * 1000;
    })
    .sort((x, y) => new Date(x.time) - new Date(y.time))[0] || null;
}

async function settleDeposit(userId, trxId, status, balance = 0) {
  if (status === "success") {
    const r = await User.updateOne(
      {
        _id: userId,
        historyDeposit: {
          $elemMatch: {
            id: trxId,
            status: { $in: ["pending", "processing"] }
          }
        }
      },
      {
        $set: { "historyDeposit.$.status": "success" },
        $inc: { saldo: Number(balance) || 0 }
      }
    );
    return r.modifiedCount > 0;
  }

  const r = await User.updateOne(
    {
      _id: userId,
      historyDeposit: {
        $elemMatch: {
          id: trxId,
          status: { $in: ["pending", "processing"] }
        }
      }
    },
    { $set: { "historyDeposit.$.status": status } }
  );

  return r.modifiedCount > 0;
}

// ================= CREATE DEPOSIT XS-PEDIA =================
router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { nominal } = req.query;

  if (!nominal || isNaN(nominal)) return res.status(400).json({ success: false, message: "Nominal tidak valid." });

  const parsedNominal = parseInt(nominal, 10);
  if (!Number.isInteger(parsedNominal) || parsedNominal < 10)
    return res.status(400).json({ success: false, message: "Minimal deposit Rp10" });

  if (!user?._id) return res.status(401).json({ success: false, message: "User API tidak valid." });

  if (!XS_PEDIA_STATIC_QR)
    return res.status(500).json({ success: false, message: "XS_PEDIA_STATIC_QR belum disetting." });

  try {
    const envPercent = getFeePercentForRole(user.role);
    const additionalFee = Math.max(0, Math.ceil(parsedNominal * (envPercent / 100)));
    const providerAmount = parsedNominal + additionalFee;

    const createUrl =
      `${XS_PEDIA_BASE_URL}/api/qris/create` +
      `?amount=${encodeURIComponent(providerAmount)}` +
      `&static_qr=${encodeURIComponent(XS_PEDIA_STATIC_QR)}`;

    let createRes;
    try {
      createRes = await fetch(createUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0"
        }
      });
    } catch (e) {
      console.error("XS-Pedia Create Fetch Error:", e);
      return res.status(502).json({ success: false, message: "Koneksi ke XS-Pedia gagal." });
    }

    const result = await createRes.json();

    if (!createRes.ok || !result?.success)
      return res.status(502).json({ success: false, message: result?.message || "Gagal membuat QRIS." });

    const rawQrImage = result.image_url || "";
    const qrisString = result.qr_string || "";

    if (!rawQrImage || !qrisString)
      return res.status(502).json({ success: false, message: "QRIS XS-Pedia tidak lengkap." });

    const trxId = `XIAO-API-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const createdAt = new Date();
    const nominalAsli = parsedNominal;
    const feeProvider = 10;
    const totalBayar = providerAmount;
    const totalFee = Math.max(0, totalBayar - nominalAsli);
    const finalBalance = nominalAsli;
    const bgUrl = DEFAULT_BG_URL;

    // BACKGROUND / COMPOSITE TETAP DIPAKAI
    let compositeQrUrl = rawQrImage;
    try {
      const generated = await createQrisComposite({
        trxId,
        qrisImageUrl: rawQrImage,
        qrisString
      });
      compositeQrUrl = `${req.protocol}://${req.get("host")}/media/generated-qris/${generated.filename}`;
    } catch (e) {
      console.error("QR Composite Error:", e.message);
    }

    const history = {
      id: trxId,
      reference_id: trxId,
      nominal: nominalAsli,
      tambahan: additionalFee,
      fee: totalFee,
      fee_env: additionalFee,
      fee_provider: feeProvider,
      total_amount: totalBayar,
      get_balance: finalBalance,
      provider_amount: providerAmount,
      provider: "xs-pedia",
      metode: "QRIS",
      status: "pending",
      qr_image: compositeQrUrl,
      qr_image_raw: rawQrImage,
      qris_string: qrisString,
      bg_image: bgUrl,
      created_at: createdAt
    };

    await tambahHistoryDeposit(user._id, history);

    res.status(200).json({
      success: true,
      message: "QRIS berhasil dibuat.",
      data: {
        id: trxId,
        trx_id: trxId,
        reference_id: trxId,
        metode: "QRIS",
        nominal: nominalAsli,
        fee: totalFee,
        fee_env: additionalFee,
        fee_provider: feeProvider,
        total_amount: totalBayar,
        get_balance: finalBalance,
        qr_image: compositeQrUrl,
        qr_image_combined: compositeQrUrl,
        qr_image_raw: rawQrImage,
        qris_string: qrisString,
        bg_image: bgUrl,
        status: "pending",
        created_at: createdAt
      }
    });

    // POLLING OTOMATIS XS-PEDIA
    const intervalId = setInterval(async () => {
      try {
        const h = await User.findOne(
          { _id: user._id, "historyDeposit.id": trxId },
          { "historyDeposit.$": 1 }
        );

        const dep = h?.historyDeposit?.[0];
        const localStatus = String(dep?.status || "").toLowerCase();

        if (!dep || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const list = await getXsHistory();
        const trx = findXsTransaction(list, dep.provider_amount || dep.total_amount, dep.created_at);

        if (!trx) return;

        const apiStatus = String(trx.status || "").toLowerCase();

        if (apiStatus === "success") {
          await User.updateOne(
            {
              _id: user._id,
              "historyDeposit": {
                $elemMatch: {
                  id: trxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": trx.id,
                "historyDeposit.$.provider_reference_id": trx.reference_id
              },
              $inc: { saldo: finalBalance }
            }
          );
          clearInterval(intervalId);
        } else if (["failed", "expired", "cancel", "cancelled"].includes(apiStatus)) {
          await settleDeposit(user._id, trxId, apiStatus);
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error("XS-Pedia Polling Error:", e.message);
      }
    }, 10000);

    // maksimal polling 30 menit
    setTimeout(() => clearInterval(intervalId), 30 * 60 * 1000);

  } catch (error) {
    console.error("XS-Pedia Deposit Create Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ================= CEK STATUS DEPOSIT XS-PEDIA =================
router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { id } = req.query;
  const { user } = req;

  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    let h = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!h?.historyDeposit?.length)
      return res.status(404).json({ success: false, message: "Data tidak ditemukan di DB." });

    let dep = h.historyDeposit[0];
    let status = String(dep.status || "pending").toLowerCase();

    if (["pending", "processing"].includes(status)) {
      const historyResponse = await getXsHistory();
      const list = Array.isArray(historyResponse)
        ? historyResponse
        : Array.isArray(historyResponse?.data)
          ? historyResponse.data
          : [];

      const expectedAmount =
        Number(dep.provider_amount) ||
        Number(dep.total_amount) ||
        Number(dep.nominal) ||
        0;

      const createdAt = dep.created_at ? new Date(dep.created_at) : null;

      const trx = list.find(item => {
        if (!item) return false;

        const apiStatus = String(item.status || "").toLowerCase();
        const amount = Number(item.amount) || 0;
        const trxTime = item.time ? new Date(item.time) : null;

        if (expectedAmount > 0 && amount !== expectedAmount) return false;

        if (createdAt && trxTime && !isNaN(trxTime.getTime())) {
          const depositTime = createdAt.getTime();
          const providerTime = trxTime.getTime();

          if (providerTime < depositTime - 60 * 1000) return false;
          if (providerTime > depositTime + 30 * 60 * 1000) return false;
        }

        return ["success", "failed", "expired", "cancel", "cancelled"].includes(apiStatus);
      });

      if (trx) {
        const apiStatus = String(trx.status || "").toLowerCase();

        if (apiStatus === "success") {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": trx.id || null,
                "historyDeposit.$.provider_reference_id": trx.reference_id || null,
                "historyDeposit.$.provider_status": apiStatus,
                "historyDeposit.$.provider_time": trx.time || null,
                "historyDeposit.$.provider_amount": Number(trx.amount) || 0
              },
              $inc: { saldo: Number(dep.get_balance) || 0 }
            }
          );

          status = "success";
        } else if (["failed", "expired", "cancel", "cancelled"].includes(apiStatus)) {
          await settleDeposit(user._id, id, apiStatus);
          status = apiStatus;
        }
      }
    }

    h = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    dep = h?.historyDeposit?.[0] || dep;
    status = String(dep.status || status).toLowerCase();

    const totalAmount =
      Number(dep.total_amount) > 0
        ? Number(dep.total_amount)
        : Number(dep.nominal || 0) + Number(dep.fee || 0);

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,
        status,
        nominal: Number(dep.nominal) || 0,
        fee: Number(dep.fee) || 0,
        fee_env: Number(dep.fee_env) || 0,
        fee_provider: Number(dep.fee_provider) || 0,
        total_amount: totalAmount,
        get_balance: Number(dep.get_balance) || 0,
        metode: dep.metode || "QRIS",
        qr_image: dep.qr_image || "",
        qr_image_raw: dep.qr_image_raw || "",
        qris_string: dep.qris_string || "",
        bg_image: dep.bg_image || DEFAULT_BG_URL,
        created_at: dep.created_at || null,
        provider_id: dep.provider_id || null,
        provider_reference_id: dep.provider_reference_id || null,
        provider_amount: Number(dep.provider_amount) || 0,
        provider_status: dep.provider_status || null,
        provider_time: dep.provider_time || null
      }
    });

  } catch (error) {
    console.error("XS-Pedia Status Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
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
