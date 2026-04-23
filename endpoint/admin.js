const express = require("express");
const axios = require("axios");
const qs = require("qs");
const app = express();
const router = express.Router();
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());

const {
  validateApiKey,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL,
  ATLAN_API_KEY,
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
  requireAdmin
} = require("../index.js");

// Import model OTP
const { Otp } = require("../index.js");

router.get("/atlantic/profile", requireAdmin, async (req, res) => {
  try {
    console.log('🔄 Mengambil data profile dari Atlantic API...');
    
    const response = await axios.get(
      "https://atlantich2h.com/get_profile",
      {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ATLAN_API_KEY}`,
          "X-API-Key": ATLAN_API_KEY
        }
      }
    );

    const extData = response.data;

    // Validasi response structure
    if (extData.status === "true" && extData.data && extData.data.balance !== undefined) {
      const result = {
        success: true,
        info: extData.message,
        profile: {
          nama: extData.data.name,
          user: extData.data.username,
          email: extData.data.email,
          hp: extData.data.phone,
          saldo: parseFloat(extData.data.balance),
          status: extData.data.status,
        },
      };
      return res.json(result);
    } else {
      throw new Error('Format respons Atlantic tidak valid');
    }
  } catch (error) {
    console.error('❌ Error mengambil data Atlantic:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil data dari Atlantic API",
      error: error.response?.data || error.message,
    });
  }
});

router.get("/data/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}, "-password -__v");
    res.json(users);
  } catch (err) {
    res.status(500).send("Server Error");
  }
});

// Endpoint untuk toggle verifikasi H2H (aktif/nonaktif)
router.post("/user/toggle-verify", requireAdmin, async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({
      success: false,
      message: "Username wajib diisi"
    });
  }

  try {
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan"
      });
    }

    // Toggle status verifikasi
    user.isVerified = !user.isVerified;
    await user.save();

    const status = user.isVerified ? "diaktifkan" : "dinonaktifkan";
    
    return res.status(200).json({
      success: true,
      message: `Verifikasi H2H user ${username} berhasil ${status}`,
      data: {
        username: user.username,
        isVerified: user.isVerified
      }
    });

  } catch (error) {
    console.error("Error toggling verification:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan server saat mengubah status verifikasi"
    });
  }
});

router.post('/user/update', requireAdmin, async (req, res) => {
  try {
    const { username, fullname, newUsername, email, nomor, role } = req.body;

    // Validasi input
    if (!username || !fullname || !newUsername || !email || !role) {
      return res.status(400).json({
        success: false,
        message: "Semua field wajib diisi (kecuali nomor telepon)"
      });
    }

    // Cari user berdasarkan username lama
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan"
      });
    }

    // Cek jika username baru sudah digunakan oleh user lain
    if (newUsername !== username) {
      const existingUser = await User.findOne({ username: newUsername });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: "Username baru sudah digunakan oleh user lain"
        });
      }
    }

    // Cek jika email sudah digunakan oleh user lain
    if (email !== user.email) {
      const existingEmail = await User.findOne({ email });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: "Email sudah digunakan oleh user lain"
        });
      }
    }

    // Update data user
    user.fullname = fullname;
    user.username = newUsername;
    user.email = email;
    user.nomor = nomor || user.nomor; // Jika nomor kosong, gunakan nilai lama
    user.role = role;

    await user.save();

    return res.status(200).json({
      success: true,
      message: `Data user ${username} berhasil diperbarui`,
      data: {
        username: user.username,
        fullname: user.fullname,
        email: user.email,
        nomor: user.nomor,
        role: user.role
      }
    });

  } catch (error) {
    console.error("❌ Error saat update data user:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message
    });
  }
});

// Endpoint untuk menghapus user
router.delete("/user/delete", requireAdmin, async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({
      success: false,
      message: "Username wajib diisi"
    });
  }

  try {
    // Cari user berdasarkan username
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan"
      });
    }

    // Cegah penghapusan admin utama
    if (user.username === "Felix") {
      return res.status(400).json({
        success: false,
        message: "Tidak dapat menghapus admin utama"
      });
    }

    // Hapus user dari database MongoDB
    await User.findOneAndDelete({ username });

    return res.status(200).json({
      success: true,
      message: `User ${username} berhasil dihapus dari database`
    });

  } catch (error) {
    console.error("Error deleting user:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan server saat menghapus user"
    });
  }
});

router.post("/user/update-balance", requireAdmin, async (req, res) => {
  const { username, newSaldo, newCoin } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, message: "Username wajib diisi." });
  }

  const saldoValue = parseFloat(newSaldo);
  const coinValue = parseFloat(newCoin);

  if (newSaldo !== undefined && (isNaN(saldoValue) || saldoValue < 0)) {
    return res.status(400).json({ success: false, message: "Nilai saldo tidak valid." });
  }
  if (newCoin !== undefined && (isNaN(coinValue) || coinValue < 0)) {
    return res.status(400).json({ success: false, message: "Nilai coin tidak valid." });
  }

  try {
    const user = await User.findOne({ username: username });
    if (!user) {
      return res.status(404).json({ success: false, message: `User '${username}' tidak ditemukan.` });
    }

    if (newSaldo !== undefined) {
      user.saldo = saldoValue;
    }
    if (newCoin !== undefined) {
      user.coin = coinValue;
    }

    await user.save();
    
    console.log(`[ADMIN] Saldo/Coin user ${user.username} diupdate oleh admin ${req.session.userId}.`);
    
    return res.status(200).json({
      success: true,
      message: `Data saldo dan coin untuk user '${user.username}' berhasil diperbarui.`,
      data: {
        username: user.username,
        saldo: user.saldo,
        coin: user.coin,
      },
    });
  } catch (error) {
    console.error("Error saat admin update balance:", error);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan pada server." });
  }
});

router.post("/update-deposit-status", requireAdmin, async (req, res) => {
  const { userId, depositId, newStatus } = req.body;

  if (!userId || !depositId || !newStatus) {
    return res.status(400).json({
      success: false,
      message: "Parameter userId, depositId, dan newStatus wajib diisi.",
    });
  }

  try {
    const result = await editHistoryDeposit(userId, depositId, newStatus);
    
    if (!result) {
        return res.status(404).json({ success: false, message: "User atau transaksi deposit tidak ditemukan." });
    }

    return res.status(200).json({
      success: true,
      message: `Status deposit dengan ID ${depositId} berhasil diubah menjadi ${newStatus}.`,
    });

  } catch (error) {
    console.error("❌ Error saat update status deposit oleh admin:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server.",
      error: error.message,
    });
  }
});

router.post("/update-order-status", requireAdmin, async (req, res) => {
  const { userId, orderId, newStatus, newSn } = req.body;

  if (!userId || !orderId || !newStatus) {
    return res.status(400).json({
      success: false,
      message: "Parameter userId, orderId, dan newStatus wajib diisi.",
    });
  }

  try {
    const user = await User.findOne({ _id: userId, "historyOrder.id": orderId });
    if (!user) {
        return res.status(404).json({ success: false, message: "User atau transaksi order tidak ditemukan." });
    }
    
    const orderToUpdate = user.historyOrder.find(o => o.id === orderId);
    
    const updateData = {
        status: newStatus,
        sn: newSn !== undefined ? newSn : orderToUpdate.sn,
    };
    
    await editHistoryOrder(userId, orderId, updateData);

    return res.status(200).json({
      success: true,
      message: `Status order dengan ID ${orderId} berhasil diubah.`,
    });

  } catch (error) {
    console.error("❌ Error saat update status order oleh admin:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server.",
      error: error.message,
    });
  }
});

router.get('/check-order', requireAdmin, async (req, res) => {
  const { id, type = 'prabayar' } = req.query;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: '❌ ID transaksi tidak boleh kosong'
    });
  }

  try {
    const response = await axios.post(
      'https://atlantich2h.com/transaksi/status',
      qs.stringify({
        api_key: ATLAN_API_KEY,
        id,
        type
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const result = response.data;

    if (!result.status || !result.data) {
      return res.status(404).json({
        success: false,
        message: '⚠️ Transaksi tidak ditemukan atau gagal'
      });
    }

    const data = result.data;
    res.json({
      success: true,
      message: 'Status transaksi berhasil diambil',
      status: data.status,
      detail: {
        id: data.id,
        reff_id: data.reff_id,
        layanan: data.layanan,
        kode: data.code,
        target: data.target,
        harga: Number(data.price),
        sn: data.sn?.trim() || null,
        waktu: data.created_at
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: '❌ Gagal memproses permintaan',
      error: error?.response?.data || error.message
    });
  }
});

router.get('/verify-user', requireAdmin, async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({
      success: false,
      message: 'Parameter username wajib diisi'
    });
  }
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User tidak ditemukan'
      });
    }
    if (user.isVerified) {
      return res.status(400).json({
        success: false,
        message: 'User sudah terverifikasi sebelumnya'
      });
    }
    user.isVerified = true;
    await user.save();
    return res.status(200).json({
      success: true,
      message: `User ${username} berhasil diverifikasi`
    });
  } catch (err) {
    console.error('Error saat memverifikasi user:', err);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan pada server'
    });
  }
});

// Endpoint untuk mendapatkan status OTP saat ini - DIPERBAIKI SESUAI FORMAT DATA
router.get('/user/otp-status', requireAdmin, async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Parameter username wajib diisi"
      });
    }

    // Cari user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan"
      });
    }

    // Cek OTP dari field user (format lama)
    if (user.otpCode && user.otpCodeExpired && new Date(user.otpCodeExpired) > new Date()) {
      const waktuSisaMenit = Math.ceil((new Date(user.otpCodeExpired) - new Date()) / (1000 * 60));
      
      return res.status(200).json({
        success: true,
        message: "OTP aktif ditemukan",
        data: {
          hasOtp: true,
          otpCode: user.otpCode,
          expiresAt: user.otpCodeExpired,
          aktifitas: user.aktifitas || "Reset Password",
          waktuSisaMenit: waktuSisaMenit,
          nomor: user.nomor,
          fullname: user.fullname,
          username: user.username
        }
      });
    }

    // Jika tidak ada OTP aktif di field user, coba cari di collection OTP
    try {
      const activeOtp = await Otp.findOne({ 
        nomor: user.nomor,
        expiresAt: { $gt: new Date() },
        used: false
      }).sort({ createdAt: -1 });

      if (activeOtp) {
        const waktuSisaMenit = Math.ceil((new Date(activeOtp.expiresAt) - new Date()) / (1000 * 60));
        
        return res.status(200).json({
          success: true,
          message: "OTP aktif ditemukan",
          data: {
            hasOtp: true,
            otpCode: activeOtp.otpCode,
            expiresAt: activeOtp.expiresAt,
            aktifitas: activeOtp.aktifitas || "Reset Password",
            waktuSisaMenit: waktuSisaMenit,
            nomor: activeOtp.nomor,
            fullname: user.fullname,
            username: user.username
          }
        });
      }
    } catch (otpError) {
      console.log("Collection OTP tidak tersedia, menggunakan data dari field user");
    }

    // Tidak ada OTP aktif
    return res.status(200).json({
      success: true,
      message: "Tidak ada OTP aktif",
      data: {
        hasOtp: false,
        nomor: user.nomor,
        fullname: user.fullname,
        username: user.username
      }
    });

  } catch (error) {
    console.error("❌ Error saat cek status OTP:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message
    });
  }
});

// Endpoint untuk mendapatkan riwayat OTP - DIPERBAIKI
router.get('/user/otp-history', requireAdmin, async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Parameter username wajib diisi"
      });
    }

    // Cari user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan"
      });
    }

    const history = [];

    // Tambahkan OTP aktif dari field user ke riwayat
    if (user.otpCode && user.otpCodeExpired) {
      history.push({
        otpCode: user.otpCode,
        aktifitas: user.aktifitas || "Reset Password",
        nomor: user.nomor,
        createdAt: user.otpCodeExpired ? new Date(user.otpCodeExpired.getTime() - 5 * 60 * 1000) : new Date(), // Estimasi waktu dibuat
        expiresAt: user.otpCodeExpired,
        isExpired: new Date() > new Date(user.otpCodeExpired),
        waktuSisaMenit: new Date() <= new Date(user.otpCodeExpired) 
          ? Math.ceil((new Date(user.otpCodeExpired) - new Date()) / (1000 * 60))
          : null
      });
    }

    // Coba tambahkan dari collection OTP
    try {
      const otpHistory = await Otp.find({ 
        nomor: user.nomor 
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('otpCode aktifitas nomor createdAt expiresAt used');

      otpHistory.forEach(otp => {
        history.push({
          otpCode: otp.otpCode,
          aktifitas: otp.aktifitas || "Reset Password",
          nomor: otp.nomor,
          createdAt: otp.createdAt,
          expiresAt: otp.expiresAt,
          isExpired: new Date() > new Date(otp.expiresAt),
          waktuSisaMenit: new Date() <= new Date(otp.expiresAt) 
            ? Math.ceil((new Date(otp.expiresAt) - new Date()) / (1000 * 60))
            : null
        });
      });
    } catch (otpError) {
      console.log("Collection OTP tidak tersedia, hanya menggunakan data dari field user");
    }

    // Urutkan berdasarkan createdAt descending
    history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      success: true,
      message: "Riwayat OTP berhasil diambil",
      data: history
    });

  } catch (error) {
    console.error("❌ Error saat mengambil riwayat OTP:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message
    });
  }
});

// Endpoint untuk menghapus OTP aktif - DIPERBAIKI
router.delete('/user/clear-otp', requireAdmin, async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({
        success: false,
        message: "Parameter username wajib diisi"
      });
    }

    // Cari user
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan"
      });
    }

    // Hapus OTP dari field user
    await User.updateOne(
      { username },
      { 
        $unset: { 
          otpCode: "",
          otpCodeExpired: "",
          aktifitas: ""
        } 
      }
    );

    // Juga hapus dari collection OTP jika ada
    try {
      await Otp.updateMany(
        { 
          nomor: user.nomor,
          expiresAt: { $gt: new Date() },
          used: false
        },
        { used: true }
      );
    } catch (otpError) {
      console.log("Collection OTP tidak tersedia, hanya menghapus dari field user");
    }

    return res.status(200).json({
      success: true,
      message: "OTP aktif berhasil dihapus"
    });

  } catch (error) {
    console.error("❌ Error saat menghapus OTP:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message
    });
  }
});

module.exports = router;
