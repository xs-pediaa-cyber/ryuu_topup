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

// ======================================================
// CREATE DEPOSIT - PAYINAJA
// STRUKTUR TETAP SEPERTI XS-PEDIA LAMA
// ======================================================
router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { nominal } = req.query;

  if (!nominal || isNaN(nominal)) {
    return res.status(400).json({
      success: false,
      message: "Nominal tidak valid."
    });
  }

  const parsedNominal = parseInt(nominal, 10);

  if (
    !Number.isInteger(parsedNominal) ||
    parsedNominal < 500
  ) {
    return res.status(400).json({
      success: false,
      message: "Minimal deposit Rp500"
    });
  }

  if (!user?._id) {
    return res.status(401).json({
      success: false,
      message: "User API tidak valid."
    });
  }

  // ==================================================
  // PAYINAJA API KEY
  // ==================================================
  const API_KEY = process.env.PAYINAJA_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      message: "PAYINAJA_API_KEY belum disetting."
    });
  }

  try {
    // ==================================================
    // FEE ENV
    // ==================================================
    const feePercentUser = parseFloat(
      process.env.FEE_PERCENT_USER
    );

    const feePercentReseller = parseFloat(
      process.env.FEE_PERCENT_RESELLER
    );

    const envPercent =
      user.role === "reseller"
        ? (
            Number.isFinite(feePercentReseller)
              ? feePercentReseller
              : 2.5
          )
        : (
            Number.isFinite(feePercentUser)
              ? feePercentUser
              : 5.5
          );

    const additionalFee = Math.max(
      0,
      Math.ceil(
        parsedNominal * (envPercent / 100)
      )
    );

    // ==================================================
    // REFERENCE ID
    // ==================================================
    const referenceId =
      `XIAO-API-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;

    // ==================================================
    // CREATE PAYINAJA
    // ==================================================
    let createRes;

    try {
      createRes = await fetch(
        "https://payinaja.com/api/v1/qris/create2",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
            "x-api-key": API_KEY
          },

          body: JSON.stringify({
            amount: parsedNominal,
            reference_id: referenceId,
            customer_name:
              user.username || "User"
          })
        }
      );
    } catch (e) {
      console.error(
        "Payinaja Create Fetch Error:",
        e
      );

      return res.status(502).json({
        success: false,
        message:
          "Koneksi ke Payinaja gagal."
      });
    }

    // ==================================================
    // RESPONSE PAYINAJA
    // ==================================================
    let result;

    try {
      result = await createRes.json();
    } catch (e) {
      console.error(
        "Payinaja JSON Error:",
        e
      );

      return res.status(502).json({
        success: false,
        message:
          "Response Payinaja tidak valid."
      });
    }

    if (
      !createRes.ok ||
      !result?.success
    ) {
      return res.status(502).json({
        success: false,
        message:
          result?.message ||
          "Gagal membuat QRIS Payinaja."
      });
    }

    const payData =
      result.data || {};

    // ==================================================
    // ID TRANSAKSI PAYINAJA
    // ==================================================
    const payinajaTrxId =
      payData.payinaja_trx_id ||
      payData.trx_id ||
      payData.id;

    if (!payinajaTrxId) {
      return res.status(502).json({
        success: false,
        message:
          "Payinaja tidak mengembalikan ID transaksi."
      });
    }

    // ==================================================
    // QR IMAGE
    // ==================================================
    const rawQrImage =
      payData.qris_image_url ||
      payData.qris_image ||
      payData.qr_image ||
      "";

    const qrisString =
      payData.qris_string ||
      payData.qris ||
      "";

    if (
      !rawQrImage ||
      !qrisString
    ) {
      return res.status(502).json({
        success: false,
        message:
          "Data QRIS Payinaja tidak lengkap."
      });
    }

    // ==================================================
    // KALKULASI
    // ==================================================
    const nominalAsli =
      Number(
        payData.amount_requested
      ) || parsedNominal;

    const feeProvider =
      Number(payData.fee) || 0;

    const providerTotal =
      Number(
        payData.total_amount
      );

    const totalBayar =
      Number.isFinite(providerTotal) &&
      providerTotal > 0
        ? Math.ceil(providerTotal)
        : Math.ceil(
            nominalAsli +
            feeProvider
          );

    const totalFee =
      feeProvider +
      additionalFee;

    /*
     * Saldo yang masuk:
     * nominal asli dikurangi fee ENV.
     */
    const finalBalance =
      Math.max(
        0,
        nominalAsli -
        additionalFee
      );

    // ==================================================
    // BACKGROUND
    // ==================================================
    const bgUrl =
      DEFAULT_BG_URL ||
      "https://files.catbox.moe/sh2bcj.png";

    // ==================================================
    // COMPOSITE QR
    // ==================================================
    let compositeQrUrl =
      rawQrImage;

    try {
      if (
        typeof createQrisComposite ===
        "function"
      ) {
        const generated =
          await createQrisComposite({
            trxId:
              String(payinajaTrxId),

            qrisImageUrl:
              rawQrImage,

            qrisString
          });

        if (
          generated?.filename
        ) {
          compositeQrUrl =
            `${req.protocol}://${req.get("host")}` +
            `/media/generated-qris/${generated.filename}`;
        }
      }
    } catch (e) {
      console.error(
        "QR Composite Error:",
        e.message
      );

      // Kalau composite gagal,
      // tetap gunakan QR asli Payinaja.
      compositeQrUrl =
        rawQrImage;
    }

    // ==================================================
    // HISTORY
    // ==================================================
    const history = {
      id:
        String(payinajaTrxId),

      reference_id:
        String(
          payData.reference_id ||
          referenceId
        ),

      reff_id:
        String(
          payData.reference_id ||
          referenceId
        ),

      nominal:
        nominalAsli,

      tambahan:
        additionalFee,

      fee:
        totalFee,

      fee_env:
        additionalFee,

      fee_provider:
        feeProvider,

      total_amount:
        totalBayar,

      get_balance:
        finalBalance,

      provider_amount:
        nominalAsli,

      provider:
        "payinaja",

      provider_id:
        String(payinajaTrxId),

      provider_reference_id:
        String(
          payData.reference_id ||
          referenceId
        ),

      provider_created_at:
        payData.created_at ||
        new Date().toISOString(),

      metode:
        "QRIS",

      status:
        "pending",

      qr_image:
        compositeQrUrl,

      qr_image_raw:
        rawQrImage,

      qris_string:
        qrisString,

      bg_image:
        bgUrl,

      created_at:
        new Date()
    };

    await tambahHistoryDeposit(
      user._id,
      history
    );

    // ==================================================
    // KIRIM RESPONSE
    // JANGAN PAKAI RETURN AGAR POLLING TETAP DIBUAT
    // ==================================================
    res.status(200).json({
      success: true,

      message:
        "QRIS berhasil dibuat.",

      data: {
        id:
          String(payinajaTrxId),

        trx_id:
          String(payinajaTrxId),

        reference_id:
          payData.reference_id ||
          referenceId,

        reff_id:
          payData.reference_id ||
          referenceId,

        metode:
          "QRIS",

        nominal:
          nominalAsli,

        fee:
          totalFee,

        fee_env:
          additionalFee,

        fee_provider:
          feeProvider,

        total_amount:
          totalBayar,

        get_balance:
          finalBalance,

        qr_image:
          compositeQrUrl,

        qr_image_combined:
          compositeQrUrl,

        qr_image_raw:
          rawQrImage,

        qris_string:
          qrisString,

        bg_image:
          bgUrl,

        status:
          "pending",

        created_at:
          history.created_at
      }
    });

    // ==================================================
    // POLLING PAYINAJA
    // ==================================================
    const intervalId =
      setInterval(
        async () => {
          try {
            // ------------------------------------------
            // CEK HISTORY LOKAL
            // ------------------------------------------
            const h =
              await User.findOne(
                {
                  _id:
                    user._id,

                  "historyDeposit.id":
                    String(
                      payinajaTrxId
                    )
                },

                {
                  "historyDeposit.$":
                    1
                }
              );

            const dep =
              h?.historyDeposit?.[0];

            const localStatus =
              String(
                dep?.status ||
                ""
              ).toLowerCase();

            // ------------------------------------------
            // KALAU SUDAH SELESAI,
            // STOP POLLING
            // ------------------------------------------
            if (
              !dep ||
              ![
                "pending",
                "processing"
              ].includes(localStatus)
            ) {
              clearInterval(
                intervalId
              );

              return;
            }

            // ------------------------------------------
            // REQUEST STATUS PAYINAJA
            // ------------------------------------------
            let checkRes;

            try {
              checkRes =
                await fetch(
                  `https://payinaja.com/api/v1/transaction/${encodeURIComponent(
                    String(payinajaTrxId)
                  )}`,
                  {
                    method:
                      "GET",

                    headers: {
                      "Accept":
                        "application/json",

                      "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                        "AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/120.0.0.0 Safari/537.36",

                      "x-api-key":
                        API_KEY
                    }
                  }
                );
            } catch (e) {
              console.error(
                "Payinaja Poll Fetch Error:",
                e.message
              );

              return;
            }

            if (
              !checkRes.ok
            ) {
              return;
            }

            let checkData;

            try {
              checkData =
                await checkRes.json();
            } catch {
              return;
            }

            const providerData =
              checkData?.data ||
              {};

            const providerStatus =
              String(
                providerData.status ||
                ""
              ).toLowerCase();

            // ------------------------------------------
            // SUCCESS
            // ------------------------------------------
            if (
              providerStatus ===
              "success"
            ) {
              const updateResult =
                await User.updateOne(
                  {
                    _id:
                      user._id,

                    historyDeposit:
                      {
                        $elemMatch:
                          {
                            id:
                              String(
                                payinajaTrxId
                              ),

                            status:
                              {
                                $in:
                                  [
                                    "pending",
                                    "processing"
                                  ]
                              }
                          }
                      }
                  },

                  {
                    $set:
                      {
                        "historyDeposit.$.status":
                          "success",

                        "historyDeposit.$.provider_id":
                          String(
                            providerData.payinaja_trx_id ||
                            providerData.trx_id ||
                            payinajaTrxId
                          ),

                        "historyDeposit.$.provider_reference_id":
                          String(
                            providerData.reference_id ||
                            referenceId
                          )
                      },

                    $inc:
                      {
                        saldo:
                          finalBalance
                      }
                  }
                );

              if (
                updateResult.modifiedCount >
                0
              ) {
                console.log(
                  `[DEPOSIT SUCCESS] ${payinajaTrxId} | ` +
                  `Saldo +Rp${finalBalance}`
                );
              }

              clearInterval(
                intervalId
              );

              return;
            }

            // ------------------------------------------
            // FAILED
            // ------------------------------------------
            if (
              [
                "failed",
                "expired",
                "cancel",
                "cancelled"
              ].includes(
                providerStatus
              )
            ) {
              const updateResult =
                await User.updateOne(
                  {
                    _id:
                      user._id,

                    historyDeposit:
                      {
                        $elemMatch:
                          {
                            id:
                              String(
                                payinajaTrxId
                              ),

                            status:
                              {
                                $in:
                                  [
                                    "pending",
                                    "processing"
                                  ]
                              }
                          }
                      }
                  },

                  {
                    $set:
                      {
                        "historyDeposit.$.status":
                          providerStatus,

                        "historyDeposit.$.provider_id":
                          String(
                            providerData.payinaja_trx_id ||
                            providerData.trx_id ||
                            payinajaTrxId
                          ),

                        "historyDeposit.$.provider_reference_id":
                          String(
                            providerData.reference_id ||
                            referenceId
                          )
                      }
                  }
                );

              if (
                updateResult.modifiedCount >
                0
              ) {
                console.log(
                  `[DEPOSIT ${providerStatus.toUpperCase()}] ${payinajaTrxId}`
                );
              }

              clearInterval(
                intervalId
              );

              return;
            }

          } catch (e) {
            console.error(
              "Payinaja Polling Error:",
              e.message
            );
          }
        },

        // Cek setiap 60 detik
        60 * 1000
      );

    // ==================================================
    // MAKSIMAL 30 MENIT
    // ==================================================
    setTimeout(
      () => {
        clearInterval(
          intervalId
        );
      },
      30 * 60 * 1000
    );

  } catch (error) {
    console.error(
      "Payinaja Deposit Create Error:",
      error
    );

    // Pastikan response belum pernah dikirim
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
});


// ======================================================
// STATUS DEPOSIT - PAYINAJA
// ======================================================
router.get(
  "/deposit/status",
  validateApiKey,
  async (req, res) => {
    const { id } =
      req.query;

    const { user } =
      req;

    if (!id) {
      return res.status(400).json({
        success: false,
        message:
          "ID diperlukan."
      });
    }

    if (!user?._id) {
      return res.status(401).json({
        success: false,
        message:
          "User API tidak valid."
      });
    }

    try {
      const transactionId =
        String(id);

      // ==================================================
      // AMBIL HISTORY
      // ==================================================
      let h =
        await User.findOne(
          {
            _id:
              user._id,

            "historyDeposit.id":
              transactionId
          },

          {
            "historyDeposit.$":
              1
          }
        );

      if (
        !h?.historyDeposit?.length
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Data tidak ditemukan di DB."
        });
      }

      let dep =
        h.historyDeposit[0];

      let status =
        String(
          dep.status ||
          "pending"
        ).toLowerCase();

      // ==================================================
      // CEK PAYINAJA KALAU MASIH PENDING
      // ==================================================
      if (
        [
          "pending",
          "processing"
        ].includes(status)
      ) {
        const API_KEY =
          process.env.PAYINAJA_API_KEY;

        if (!API_KEY) {
          return res.status(500).json({
            success: false,
            message:
              "PAYINAJA_API_KEY belum disetting."
          });
        }

        let checkRes;

        try {
          checkRes =
            await fetch(
              `https://payinaja.com/api/v1/transaction/${encodeURIComponent(
                transactionId
              )}`,
              {
                method:
                  "GET",

                headers: {
                  "Accept":
                    "application/json",

                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/120.0.0.0 Safari/537.36",

                  "x-api-key":
                    API_KEY
                }
              }
            );
        } catch (e) {
          console.error(
            "Payinaja Status Fetch Error:",
            e.message
          );

          return res.status(502).json({
            success: false,
            message:
              "Koneksi ke Payinaja gagal."
          });
        }

        if (
          checkRes.ok
        ) {
          let result;

          try {
            result =
              await checkRes.json();
          } catch {
            result =
              null;
          }

          const providerData =
            result?.data ||
            {};

          const providerStatus =
            String(
              providerData.status ||
              status
            ).toLowerCase();

          // ==========================================
          // SUCCESS
          // ==========================================
          if (
            providerStatus ===
              "success" &&
            [
              "pending",
              "processing"
            ].includes(status)
          ) {
            const updateResult =
              await User.updateOne(
                {
                  _id:
                    user._id,

                  historyDeposit:
                    {
                      $elemMatch:
                        {
                          id:
                            transactionId,

                          status:
                            {
                              $in:
                                [
                                  "pending",
                                  "processing"
                                ]
                            }
                        }
                    }
                },

                {
                  $set:
                    {
                      "historyDeposit.$.status":
                        "success",

                      "historyDeposit.$.provider_id":
                        String(
                          providerData.payinaja_trx_id ||
                          providerData.trx_id ||
                          transactionId
                        ),

                      "historyDeposit.$.provider_reference_id":
                        String(
                          providerData.reference_id ||
                          dep.reff_id ||
                          transactionId
                        )
                    },

                  $inc:
                    {
                      saldo:
                        Number(
                          dep.get_balance
                        ) || 0
                    }
                }
              );

            if (
              updateResult.modifiedCount >
              0
            ) {
              status =
                "success";
            }
          }

          // ==========================================
          // FAILED / EXPIRED / CANCEL
          // ==========================================
          else if (
            [
              "failed",
              "expired",
              "cancel",
              "cancelled"
            ].includes(
              providerStatus
            )
          ) {
            const updateResult =
              await User.updateOne(
                {
                  _id:
                    user._id,

                  historyDeposit:
                    {
                      $elemMatch:
                        {
                          id:
                            transactionId,

                          status:
                            {
                              $in:
                                [
                                  "pending",
                                  "processing"
                                ]
                            }
                        }
                    }
                },

                {
                  $set:
                    {
                      "historyDeposit.$.status":
                        providerStatus,

                      "historyDeposit.$.provider_id":
                        String(
                          providerData.payinaja_trx_id ||
                          providerData.trx_id ||
                          transactionId
                        ),

                      "historyDeposit.$.provider_reference_id":
                        String(
                          providerData.reference_id ||
                          dep.reff_id ||
                          transactionId
                        )
                    }
                }
              );

            if (
              updateResult.modifiedCount >
              0
            ) {
              status =
                providerStatus;
            }
          }
        }
      }

      // ==================================================
      // REFRESH DATA
      // ==================================================
      h =
        await User.findOne(
          {
            _id:
              user._id,

            "historyDeposit.id":
              transactionId
          },

          {
            "historyDeposit.$":
              1
          }
        );

      dep =
        h?.historyDeposit?.[0] ||
        dep;

      status =
        String(
          dep.status ||
          status
        ).toLowerCase();

      // ==================================================
      // DATA RESPONSE
      // ==================================================
      const nominal =
        Number(
          dep.nominal
        ) || 0;

      const fee =
        Number(
          dep.fee
        ) || 0;

      const totalAmount =
        Number(
          dep.total_amount
        ) > 0
          ? Number(
              dep.total_amount
            )
          : Math.max(
              0,
              nominal + fee
            );

      return res.status(200).json({
        success: true,

        data: {
          id:
            transactionId,

          trx_id:
            transactionId,

          reference_id:
            dep.reff_id ||
            dep.reference_id ||
            "-",

          reff_id:
            dep.reff_id ||
            dep.reference_id ||
            "-",

          metode:
            dep.metode ||
            "QRIS",

          nominal,

          fee,

          fee_env:
            Number(
              dep.fee_env
            ) || 0,

          fee_provider:
            Number(
              dep.fee_provider
            ) || 0,

          total_amount:
            totalAmount,

          get_balance:
            Number(
              dep.get_balance
            ) || 0,

          qr_image:
            dep.qr_image ||
            null,

          qr_image_raw:
            dep.qr_image_raw ||
            null,

          qris_string:
            dep.qris_string ||
            "",

          bg_image:
            dep.bg_image ||
            DEFAULT_BG_URL,

          status,

          created_at:
            dep.created_at ||
            null
        }
      });

    } catch (error) {
      console.error(
        "Payinaja Deposit Status Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);


// ======================================================
// CANCEL DEPOSIT - LOCAL
// ======================================================
router.get(
  "/deposit/cancel",
  validateApiKey,
  async (req, res) => {
    const { user } =
      req;

    const { id } =
      req.query;

    if (!id) {
      return res.status(400).json({
        success: false,
        message:
          "ID diperlukan."
      });
    }

    if (!user?._id) {
      return res.status(401).json({
        success: false,
        message:
          "User API tidak valid."
      });
    }

    try {
      const transactionId =
        String(id);

      // ==================================================
      // CEK HISTORY
      // ==================================================
      const userHistory =
        await User.findOne(
          {
            _id:
              user._id,

            "historyDeposit.id":
              transactionId
          },

          {
            "historyDeposit.$":
              1
          }
        );

      if (
        !userHistory ||
        !userHistory.historyDeposit?.length
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Data transaksi tidak ditemukan."
        });
      }

      const currentData =
        userHistory
          .historyDeposit[0];

      const currentStatus =
        String(
          currentData.status ||
          "pending"
        ).toLowerCase();

      // ==================================================
      // SUDAH SELESAI
      // ==================================================
      if (
        currentStatus !==
          "pending" &&
        currentStatus !==
          "processing"
      ) {
        return res.status(400).json({
          success: false,
          message:
            `Transaksi tidak bisa dibatalkan karena status sudah ${currentStatus}.`
        });
      }

      // ==================================================
      // CANCEL INTERNAL
      // ==================================================
      await editHistoryDeposit(
        user._id,
        transactionId,
        "cancel"
      );

      return res.status(200).json({
        success: true,

        message:
          "Deposit berhasil dibatalkan.",

        data: {
          id:
            transactionId,

          trx_id:
            transactionId,

          status:
            "cancel"
        }
      });

    } catch (error) {
      console.error(
        "Payinaja Cancel Deposit Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          error.message
      });
    }
  }
);
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
