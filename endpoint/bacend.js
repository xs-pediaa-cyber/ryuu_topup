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


// ======================================================
// CREATE DEPOSIT - PAYINAJA
// ======================================================
router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal, 10);

    if (
      !nominal ||
      !Number.isInteger(parsedNominal) ||
      parsedNominal < 500
    ) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp500"
      });
    }

    // ==================================================
    // ENV PAYINAJA
    // ==================================================
    const API_KEY = process.env.PAYINAJA_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "PAYINAJA_API_KEY belum disetting di server."
      });
    }

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

    // Fee tambahan yang dibebankan ke user
    const additionalFee = Math.max(
      0,
      Math.ceil(parsedNominal * (envPercent / 100))
    );

    // ==================================================
    // CREATE PAYINAJA
    // ==================================================
    const referenceId =
      `DEP-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;

    let response;

    try {
      response = await fetch(
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
            customer_name: user.username || "User"
          })
        }
      );
    } catch (fetchError) {
      console.error(
        "Payinaja Create Fetch Error:",
        fetchError
      );

      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Payinaja gagal."
      });
    }

    let result;

    try {
      result = await response.json();
    } catch (jsonError) {
      console.error(
        "Payinaja JSON Error:",
        jsonError
      );

      return res.status(502).json({
        success: false,
        message: "Response Payinaja tidak valid."
      });
    }

    if (!response.ok || !result?.success) {
      return res.status(400).json({
        success: false,
        message:
          result?.message ||
          "Gagal membuat QRIS Payinaja."
      });
    }

    const payData = result.data || {};

    // ==================================================
    // DATA PAYINAJA
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

    const qrImage =
      payData.qris_image_url ||
      payData.qris_image ||
      payData.qr_image ||
      null;

    const qrisString =
      payData.qris_string ||
      payData.qris ||
      "";

    if (!qrImage || !qrisString) {
      return res.status(502).json({
        success: false,
        message:
          "Payinaja tidak mengembalikan data QRIS lengkap."
      });
    }

    // ==================================================
    // KALKULASI
    // ==================================================
    const nominalAsli =
      Number(payData.amount_requested) ||
      parsedNominal;

    const feePayinaja =
      Number(payData.fee) || 0;

    /*
     * total_amount dari Payinaja biasanya sudah
     * mencakup fee provider.
     */
    const providerTotal =
      Number(payData.total_amount);

    const totalBayar =
      Number.isFinite(providerTotal) &&
      providerTotal > 0
        ? Math.ceil(providerTotal)
        : Math.ceil(
            nominalAsli + feePayinaja
          );

    /*
     * Fee keseluruhan:
     * fee Payinaja + fee tambahan dari ENV
     */
    const totalFee =
      feePayinaja + additionalFee;

    /*
     * Saldo yang masuk ke user.
     * Nominal deposit dikurangi fee tambahan
     * dari sistem.
     *
     * Fee Payinaja sudah tercermin pada
     * total pembayaran.
     */
    const finalGetBalance = Math.max(
      0,
      nominalAsli - additionalFee
    );

    // ==================================================
    // BACKGROUND TETAP
    // ==================================================
    const customBgUrl =
      "https://files.catbox.moe/sh2bcj.png";

    // ==================================================
    // SIMPAN HISTORY
    // ==================================================
    const historyDataForDb = {
      id: String(payinajaTrxId),
      reff_id: String(
        payData.reference_id ||
        referenceId
      ),

      nominal: nominalAsli,

      // Fee keseluruhan
      fee: totalFee,

      // Detail fee agar kompatibel dengan data lama
      fee_env: additionalFee,
      fee_provider: feePayinaja,
      tambahan: additionalFee,

      total_amount: totalBayar,

      get_balance: finalGetBalance,

      provider_amount: nominalAsli,

      provider: "payinaja",
      provider_id: String(payinajaTrxId),
      provider_reference_id:
        String(
          payData.reference_id ||
          referenceId
        ),

      provider_created_at:
        payData.created_at ||
        new Date().toISOString(),

      qris_string: qrisString,

      metode: "QRIS",

      status: "pending",

      qr_image: qrImage,

      // Background tidak diubah
      bg_image: customBgUrl,

      created_at: new Date()
    };

    await tambahHistoryDeposit(
      user._id,
      historyDataForDb
    );

    // ==================================================
    // RESPONSE KE FRONTEND
    // ==================================================
    return res.status(200).json({
      success: true,
      data: {
        id: String(payinajaTrxId),

        trx_id: String(payinajaTrxId),

        reff_id:
          payData.reference_id ||
          referenceId,

        metode: "QRIS",

        nominal: nominalAsli,

        fee: totalFee,

        fee_env: additionalFee,

        fee_provider: feePayinaja,

        total_amount: totalBayar,

        get_balance: finalGetBalance,

        // Tetap nama qr_image
        qr_image: qrImage,

        qris_string: qrisString,

        // Background tetap sama
        bg_image: customBgUrl,

        status: "pending"
      }
    });

    // ==================================================
    // POLLING PAYINAJA
    // ==================================================
    const intervalId = setInterval(
      async () => {
        try {
          const checkRes = await fetch(
            `https://payinaja.com/api/v1/transaction/${encodeURIComponent(
              payinajaTrxId
            )}`,
            {
              method: "GET",
              headers: {
                "Accept":
                  "application/json",
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                  "AppleWebKit/537.36 (KHTML, like Gecko) " +
                  "Chrome/120.0.0.0 Safari/537.36",
                "x-api-key": API_KEY
              }
            }
          );

          if (!checkRes.ok) {
            return;
          }

          const checkData =
            await checkRes.json();

          const providerStatus =
            String(
              checkData?.data?.status || ""
            ).toLowerCase();

          if (
            providerStatus === "success"
          ) {
            /*
             * Atomic update:
             * saldo hanya ditambahkan jika
             * status masih pending/processing.
             *
             * Ini mencegah saldo masuk dua kali.
             */
            const updateResult =
              await User.updateOne(
                {
                  _id: user._id,
                  historyDeposit: {
                    $elemMatch: {
                      id: String(
                        payinajaTrxId
                      ),
                      status: {
                        $in: [
                          "pending",
                          "processing"
                        ]
                      }
                    }
                  }
                },
                {
                  $set: {
                    "historyDeposit.$.status":
                      "success",
                    "historyDeposit.$.provider_id":
                      String(
                        payinajaTrxId
                      ),
                    "historyDeposit.$.provider_reference_id":
                      String(
                        checkData?.data
                          ?.reference_id ||
                        payinajaTrxId
                      )
                  },

                  $inc: {
                    saldo: finalGetBalance
                  }
                }
              );

            if (
              updateResult.modifiedCount > 0
            ) {
              console.log(
                `Deposit SUCCESS ${payinajaTrxId} | ` +
                `Saldo +Rp${finalGetBalance}`
              );
            }

            clearInterval(intervalId);

            return;
          }

          if (
            [
              "failed",
              "expired",
              "cancel",
              "cancelled"
            ].includes(providerStatus)
          ) {
            await User.updateOne(
              {
                _id: user._id,
                historyDeposit: {
                  $elemMatch: {
                    id: String(
                      payinajaTrxId
                    ),
                    status: {
                      $in: [
                        "pending",
                        "processing"
                      ]
                    }
                  }
                }
              },
              {
                $set: {
                  "historyDeposit.$.status":
                    providerStatus
                }
              }
            );

            console.log(
              `Deposit ${providerStatus.toUpperCase()} ${payinajaTrxId}`
            );

            clearInterval(intervalId);
          }
        } catch (e) {
          console.error(
            "Payinaja Polling Error:",
            e.message
          );
        }
      },

      // Cek tiap 60 detik
      60 * 1000
    );

    // Maksimal polling 30 menit
    setTimeout(() => {
      clearInterval(intervalId);
    }, 30 * 60 * 1000);

  } catch (err) {
    console.error(
      "Deposit Create Error:",
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message
    });
  }
});


// ======================================================
// STATUS DEPOSIT - PAYINAJA
// ======================================================
router.post(
  "/deposit/status",
  requireLogin,
  async (req, res) => {
    const user = await User.findById(
      req.session.userId
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID diperlukan."
      });
    }

    try {
      // ==================================================
      // AMBIL HISTORY LOKAL
      // ==================================================
      let userWithHistory =
        await User.findOne(
          {
            _id: user._id,
            "historyDeposit.id": String(id)
          },
          {
            "historyDeposit.$": 1
          }
        );

      if (
        !userWithHistory ||
        !userWithHistory.historyDeposit?.length
      ) {
        return res.status(404).json({
          success: false,
          message: "Data tidak ditemukan."
        });
      }

      let localData =
        userWithHistory
          .historyDeposit[0];

      let localStatus =
        String(
          localData.status ||
          "pending"
        ).toLowerCase();

      // ==================================================
      // KALAU SUDAH TERMINAL
      // ==================================================
      if (
        ![
          "pending",
          "processing"
        ].includes(localStatus)
      ) {
        return res.status(200).json({
          success: true,
          data: {
            id: String(id),

            trx_id: String(id),

            reff_id:
              localData.reff_id ||
              "-",

            nominal:
              Number(
                localData.nominal
              ) || 0,

            total_amount:
              Number(
                localData.total_amount
              ) > 0
                ? Number(
                    localData.total_amount
                  )
                : Math.max(
                    0,
                    (
                      Number(
                        localData.nominal
                      ) || 0
                    ) +
                    (
                      Number(
                        localData.fee
                      ) || 0
                    )
                  ),

            fee:
              Number(
                localData.fee
              ) || 0,

            get_balance:
              Number(
                localData.get_balance
              ) || 0,

            status: localStatus,

            metode:
              localData.metode ||
              "QRIS",

            qr_image:
              localData.qr_image ||
              null,

            // Background tetap
            bg_image:
              localData.bg_image ||
              "https://files.catbox.moe/sh2bcj.png",

            qris_string:
              localData.qris_string ||
              "",

            created_at:
              localData.created_at ||
              null
          }
        });
      }

      const API_KEY =
        process.env.PAYINAJA_API_KEY;

      if (!API_KEY) {
        return res.status(500).json({
          success: false,
          message:
            "PAYINAJA_API_KEY belum disetting di server."
        });
      }

      // ==================================================
      // CEK STATUS PAYINAJA
      // ==================================================
      const response =
        await fetch(
          `https://payinaja.com/api/v1/transaction/${encodeURIComponent(
            id
          )}`,
          {
            method: "GET",
            headers: {
              "Accept":
                "application/json",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/120.0.0.0 Safari/537.36",
              "x-api-key": API_KEY
            }
          }
        );

      if (!response.ok) {
        return res.status(502).json({
          success: false,
          message:
            "Gagal mengambil status dari Payinaja."
        });
      }

      const result =
        await response.json();

      const providerData =
        result?.data || {};

      const providerStatus =
        String(
          providerData.status ||
          localStatus
        ).toLowerCase();

      // ==================================================
      // SUCCESS
      // ==================================================
      if (
        providerStatus === "success" &&
        [
          "pending",
          "processing"
        ].includes(localStatus)
      ) {
        const updateResult =
          await User.updateOne(
            {
              _id: user._id,

              historyDeposit: {
                $elemMatch: {
                  id: String(id),
                  status: {
                    $in: [
                      "pending",
                      "processing"
                    ]
                  }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status":
                  "success",

                "historyDeposit.$.provider_id":
                  String(
                    providerData.payinaja_trx_id ||
                    providerData.trx_id ||
                    id
                  ),

                "historyDeposit.$.provider_reference_id":
                  String(
                    providerData.reference_id ||
                    id
                  )
              },

              $inc: {
                saldo:
                  Number(
                    localData.get_balance
                  ) || 0
              }
            }
          );

        if (
          updateResult.modifiedCount > 0
        ) {
          localStatus = "success";
        }
      }

      // ==================================================
      // FAILED / EXPIRED / CANCEL
      // ==================================================
      else if (
        [
          "failed",
          "expired",
          "cancel",
          "cancelled"
        ].includes(providerStatus)
      ) {
        await User.updateOne(
          {
            _id: user._id,

            historyDeposit: {
              $elemMatch: {
                id: String(id),
                status: {
                  $in: [
                    "pending",
                    "processing"
                  ]
                }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status":
                providerStatus,

              "historyDeposit.$.provider_id":
                String(
                  providerData.payinaja_trx_id ||
                  providerData.trx_id ||
                  id
                ),

              "historyDeposit.$.provider_reference_id":
                String(
                  providerData.reference_id ||
                  id
                )
            }
          }
        );

        localStatus =
          providerStatus;
      }

      // ==================================================
      // REFRESH HISTORY
      // ==================================================
      const refreshedUser =
        await User.findOne(
          {
            _id: user._id,
            "historyDeposit.id":
              String(id)
          },
          {
            "historyDeposit.$": 1
          }
        );

      localData =
        refreshedUser
          ?.historyDeposit?.[0] ||
        localData;

      localStatus =
        String(
          localData.status ||
          localStatus
        ).toLowerCase();

      const nominal =
        Number(
          localData.nominal
        ) ||
        Number(
          providerData.amount_requested
        ) ||
        0;

      const fee =
        Number(
          localData.fee
        ) || 0;

      const totalAmount =
        Number(
          localData.total_amount
        ) > 0
          ? Number(
              localData.total_amount
            )
          : (
              Number(
                providerData.total_amount
              ) ||
              Math.max(
                0,
                nominal + fee
              )
            );

      // ==================================================
      // RESPONSE
      // ==================================================
      return res.status(200).json({
        success: true,
        data: {
          id: String(id),

          trx_id: String(id),

          reff_id:
            localData.reff_id ||
            providerData.reference_id ||
            "-",

          nominal,

          total_amount:
            totalAmount,

          fee,

          get_balance:
            Number(
              localData.get_balance
            ) || 0,

          status:
            localStatus,

          metode:
            localData.metode ||
            "QRIS",

          qr_image:
            localData.qr_image ||
            providerData.qris_image_url ||
            providerData.qris_image ||
            null,

          // Background tetap
          bg_image:
            localData.bg_image ||
            "https://files.catbox.moe/sh2bcj.png",

          qris_string:
            localData.qris_string ||
            providerData.qris_string ||
            providerData.qris ||
            "",

          created_at:
            localData.created_at ||
            null
        }
      });

    } catch (error) {
      console.error(
        "Error Status Check Payinaja:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Gagal memuat detail terbaru."
      });
    }
  }
);


// ======================================================
// CANCEL DEPOSIT
// ======================================================
router.post(
  "/deposit/cancel",
  requireLogin,
  async (req, res) => {
    const user = await User.findById(
      req.session.userId
    );

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { id } = req.body;

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
            _id: user._id,
            "historyDeposit.id":
              String(id)
          },
          {
            "historyDeposit.$": 1
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
        userHistory.historyDeposit[0];

      const currentStatus =
        String(
          currentData.status ||
          "pending"
        ).toLowerCase();

      if (
        currentStatus !== "pending" &&
        currentStatus !== "processing"
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
        String(id),
        "cancel"
      );

      return res.status(200).json({
        success: true,
        message:
          "Deposit berhasil dibatalkan.",
        data: {
          id: String(id),
          status: "cancel"
        }
      });

    } catch (error) {
      console.error(
        "Cancel Deposit Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Terjadi kesalahan: " +
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
