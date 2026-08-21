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
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const QRIS_BACKGROUND_URL = "https://files.catbox.moe/sh2bcj.png";

async function createQrisWithBackground(qrisUrl, trxId) {
  try {
    if (!qrisUrl) {
      throw new Error("QRIS Payinaja tidak tersedia.");
    }

    const [backgroundResponse, qrisResponse] = await Promise.all([
      fetch(QRIS_BACKGROUND_URL),
      fetch(qrisUrl)
    ]);

    if (!backgroundResponse.ok) {
      throw new Error(`Gagal mengambil background QRIS. HTTP ${backgroundResponse.status}`);
    }

    if (!qrisResponse.ok) {
      throw new Error(`Gagal mengambil QRIS Payinaja. HTTP ${qrisResponse.status}`);
    }

    const backgroundBuffer = Buffer.from(
      await backgroundResponse.arrayBuffer()
    );

    const qrisBuffer = Buffer.from(
      await qrisResponse.arrayBuffer()
    );

    const qrisSize = 520;

    const qrisResize = await sharp(qrisBuffer)
      .resize(qrisSize, qrisSize, {
        fit: "contain",
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        }
      })
      .png()
      .toBuffer();

    const qrisDir = path.join(
      __dirname,
      "../public/media/qris"
    );

    if (!fs.existsSync(qrisDir)) {
      fs.mkdirSync(qrisDir, {
        recursive: true
      });
    }

    const fileName = `qris-${trxId}.png`;
    const outputPath = path.join(qrisDir, fileName);

    await sharp(backgroundBuffer)
      .composite([
        {
          input: qrisResize,
          left: 531,
          top: 560
        }
      ])
      .png()
      .toFile(outputPath);

    return `/media/qris/${fileName}`;
  } catch (error) {
    console.error(
      "Create QRIS Background Error:",
      error.message
    );

    return null;
  }
}

router.get("/deposit/metode", validateApiKey, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.user?.role || "user";

    const feeUser = Number(
      process.env.DEPOSIT_FEE_USER_PERCENT || 0.2
    );

    const feeReseller = Number(
      process.env.DEPOSIT_FEE_RESELLER_PERCENT || 0.1
    );

    const feePersen =
      role === "reseller"
        ? feeReseller
        : feeUser;

    const metodeFormatted = [
      {
        metode: "QRIS",
        type: "ewallet",
        name: "QRIS All Payment (Otomatis)",
        min: 500,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen.toString(),
        status: "aktif",
        img_url: `${fullUrl}/media/metode/qrisfast.png`
      }
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Payinaja",
      metode: metodeFormatted
    });
  } catch (error) {
    console.error(
      "Deposit Metode Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode."
    });
  }
});

router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { nominal } = req.query;

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }

  if (!nominal || isNaN(nominal)) {
    return res.status(400).json({
      success: false,
      message: "Nominal tidak valid."
    });
  }

  const parsedNominal = parseInt(nominal);

  if (
    isNaN(parsedNominal) ||
    parsedNominal < 500
  ) {
    return res.status(400).json({
      success: false,
      message: "Minimal deposit Rp500"
    });
  }

  const API_KEY =
    process.env.PAYINAJA_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      message: "API Key Payinaja belum disetting."
    });
  }

  try {
    const feeUserPercent = Number(
      process.env.DEPOSIT_FEE_USER_PERCENT || 0.2
    );

    const feeResellerPercent = Number(
      process.env.DEPOSIT_FEE_RESELLER_PERCENT || 0.1
    );

    const role = user.role || "user";

    const feePersen =
      role === "reseller"
        ? feeResellerPercent
        : feeUserPercent;

    let response;

    try {
      response = await fetch(
        "https://payinaja.com/api/v1/qris/create2",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "x-api-key": API_KEY
          },
          body: JSON.stringify({
            amount: parsedNominal,
            reference_id: `DEP-${Date.now()}`,
            customer_name: user.username || "Pelanggan"
          })
        }
      );
    } catch (fetchError) {
      console.error(
        "Fetch API Error:",
        fetchError
      );

      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Payinaja gagal/diblokir."
      });
    }

    const result =
      await response.json();

    if (
      !result ||
      !result.success
    ) {
      return res.status(502).json({
        success: false,
        message:
          result?.message ||
          "Gagal membuat QRIS."
      });
    }

    const payData =
      result.data;

    const nominalAsli =
      Number(
        payData.amount_requested
      ) || parsedNominal;

    const feePayinaja =
      Number(
        payData.fee
      ) || 0;

    const totalBayar =
      Number(
        payData.total_amount
      ) ||
      (
        nominalAsli +
        feePayinaja
      );

    const additionalFee =
      Math.ceil(
        nominalAsli *
        (feePersen / 100)
      );

    const totalFee =
      additionalFee +
      feePayinaja;

    const finalBalance =
      nominalAsli -
      additionalFee;

    const qrisFinalPath =
      await createQrisWithBackground(
        payData.qris_image_url,
        payData.payinaja_trx_id
      );

    const fullUrl =
      `${req.protocol}://${req.get("host")}`;

    const finalQrImage =
      qrisFinalPath
        ? `${fullUrl}${qrisFinalPath}`
        : payData.qris_image_url;

    const history = {
      id:
        payData.payinaja_trx_id,

      nominal:
        nominalAsli,

      fee:
        totalFee,

      fee_persen:
        feePersen,

      fee_payinaja:
        feePayinaja,

      fee_tambahan:
        additionalFee,

      get_balance:
        finalBalance,

      metode:
        "QRIS",

      status:
        "pending",

      qr_image:
        finalQrImage,

      qris_original:
        payData.qris_image_url,

      qris_string:
        payData.qris_string ||
        payData.qris ||
        "",

      bg_image:
        QRIS_BACKGROUND_URL,

      created_at:
        new Date()
    };

    await tambahHistoryDeposit(
      user._id,
      history
    );

    res.status(200).json({
      success: true,
      data: {
        id:
          history.id,

        trx_id:
          history.id,

        metode:
          "QRIS",

        nominal:
          nominalAsli,

        fee:
          totalFee,

        fee_persen:
          feePersen,

        fee_payinaja:
          feePayinaja,

        fee_tambahan:
          additionalFee,

        get_balance:
          finalBalance,

        total_amount:
          totalBayar,

        qr_image:
          finalQrImage,

        qris_original:
          payData.qris_image_url,

        qris_string:
          history.qris_string,

        bg_image:
          QRIS_BACKGROUND_URL,

        status:
          "pending"
      }
    });

    const intervalId =
      setInterval(async () => {
        try {
          const checkRes =
            await fetch(
              `https://payinaja.com/api/v1/transaction/${payData.payinaja_trx_id}`,
              {
                method: "GET",
                headers: {
                  "Accept": "application/json",
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                  "x-api-key": API_KEY
                }
              }
            );

          const statusData =
            await checkRes.json();

          if (
            statusData?.success &&
            statusData?.data
          ) {
            const apiStatus =
              String(
                statusData.data.status || ""
              ).toLowerCase();

            if (
              apiStatus === "success"
            ) {
              const userCheck =
                await User.findOne({
                  _id:
                    user._id,

                  "historyDeposit.id":
                    payData.payinaja_trx_id
                });

              const txInDb =
                userCheck?.historyDeposit?.find(
                  tx =>
                    tx.id ===
                    payData.payinaja_trx_id
                );

              if (
                txInDb &&
                txInDb.status !== "success"
              ) {
                await editHistoryDeposit(
                  user._id,
                  payData.payinaja_trx_id,
                  "success"
                );

                await User.findByIdAndUpdate(
                  user._id,
                  {
                    $inc: {
                      saldo:
                        finalBalance
                    }
                  }
                );

                console.log(
                  `Deposit ${payData.payinaja_trx_id} sukses. Saldo +Rp${finalBalance}`
                );
              }

              clearInterval(
                intervalId
              );

              return;
            }

            if (
              [
                "failed",
                "expired",
                "cancel"
              ].includes(
                apiStatus
              )
            ) {
              await editHistoryDeposit(
                user._id,
                payData.payinaja_trx_id,
                apiStatus
              );

              clearInterval(
                intervalId
              );

              return;
            }
          }
        } catch (error) {
          console.error(
            "Polling API Error:",
            error.message
          );

          clearInterval(
            intervalId
          );
        }
      }, 10000);

  } catch (error) {
    console.error(
      "Deposit Create Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { id } = req.query;
  const { user } = req;

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID diperlukan."
    });
  }

  try {
    const userHistory =
      await User.findOne(
        {
          _id:
            user._id,

          "historyDeposit.id":
            id
        },
        {
          "historyDeposit.$":
            1
        }
      );

    if (
      !userHistory ||
      !userHistory.historyDeposit ||
      !userHistory.historyDeposit.length
    ) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan di DB."
      });
    }

    const localData =
      userHistory.historyDeposit[0];

    const API_KEY =
      process.env.PAYINAJA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key Payinaja belum disetting."
      });
    }

    let result;

    try {
      const response =
        await fetch(
          `https://payinaja.com/api/v1/transaction/${id}`,
          {
            method: "GET",
            headers: {
              "Accept": "application/json",
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              "x-api-key": API_KEY
            }
          }
        );

      result =
        await response.json();

    } catch (providerError) {
      console.error(
        "Payinaja Status Error:",
        providerError.message
      );

      return res.status(502).json({
        success: false,
        message: "Gagal menghubungi Payinaja."
      });
    }

    if (
      !result ||
      !result.success ||
      !result.data
    ) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan di provider."
      });
    }

    const apiStatus =
      String(
        result.data.status || ""
      ).toLowerCase();

    if (
      apiStatus === "success" &&
      localData.status !== "success"
    ) {
      const userCheck =
        await User.findOne({
          _id:
            user._id,

          "historyDeposit.id":
            id
        });

      const txInDb =
        userCheck?.historyDeposit?.find(
          tx =>
            tx.id === id
        );

      if (
        txInDb &&
        txInDb.status !== "success"
      ) {
        await editHistoryDeposit(
          user._id,
          id,
          "success"
        );

        await User.findByIdAndUpdate(
          user._id,
          {
            $inc: {
              saldo:
                Number(
                  localData.get_balance
                ) || 0
            }
          }
        );
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        id:
          id,

        trx_id:
          id,

        status:
          apiStatus,

        nominal:
          Number(
            result.data.amount_requested
          ) ||
          Number(
            localData.nominal
          ) ||
          0,

        fee:
          Number(
            localData.fee
          ) || 0,

        fee_persen:
          Number(
            localData.fee_persen
          ) || 0,

        fee_payinaja:
          Number(
            localData.fee_payinaja
          ) || 0,

        fee_tambahan:
          Number(
            localData.fee_tambahan
          ) || 0,

        get_balance:
          Number(
            localData.get_balance
          ) || 0,

        total_amount:
          Number(
            result.data.total_amount
          ) ||
          (
            Number(
              localData.nominal
            ) +
            Number(
              localData.fee_payinaja
            )
          ) ||
          0,

        metode:
          localData.metode ||
          "QRIS",

        qr_image:
          localData.qr_image ||
          result.data.qris_image_url ||
          null,

        qris_original:
          localData.qris_original ||
          result.data.qris_image_url ||
          null,

        qris_string:
          localData.qris_string ||
          result.data.qris_string ||
          result.data.qris ||
          "",

        bg_image:
          localData.bg_image ||
          QRIS_BACKGROUND_URL
      }
    });

  } catch (error) {
    console.error(
      "Deposit Status Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error.message
    });
  }
});

router.get("/deposit/cancel", validateApiKey, async (req, res) => {
  const { user } = req;
  const { id } = req.query;

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan."
    });
  }

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID diperlukan."
    });
  }

  try {
    const userHistory =
      await User.findOne({
        _id:
          user._id,

        "historyDeposit.id":
          id
      });

    if (
      !userHistory ||
      !userHistory.historyDeposit ||
      !userHistory.historyDeposit.length
    ) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    const tx =
      userHistory.historyDeposit.find(
        item =>
          item.id === id
      );

    if (!tx) {
      return res.status(404).json({
        success: false,
        message: "Transaksi tidak ditemukan."
      });
    }

    if (
      tx.status === "success"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Transaksi yang sudah sukses tidak dapat dibatalkan."
      });
    }

    if (
      tx.status === "cancel"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Transaksi sudah dibatalkan."
      });
    }

    await editHistoryDeposit(
      user._id,
      id,
      "cancel"
    );

    return res.status(200).json({
      success: true,
      data: {
        id:
          id,

        status:
          "cancel"
      }
    });

  } catch (error) {
    console.error(
      "Deposit Cancel Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        error.message
    });
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
