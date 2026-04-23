   (() => {
      const API_BASE = '/deposit';
      const PROFILE_API = '/profile/users';

      const depositForm = document.getElementById('depositForm');
      const depositTypeSelect = document.getElementById('depositType');
      const methodsList = document.getElementById('methodsList');
      const nominalInput = document.getElementById('nominalInput');
      const submitBtn = depositForm.querySelector('button[type="submit"]');
      const depositResult = document.getElementById('depositResult');

      const profileBtn = document.getElementById('profileBtn');
      const profilePopup = document.getElementById('profilePopup');
      const profileFullname = document.getElementById('profileFullname');
      const profileUsernamePopup = document.getElementById('profileUsernamePopup');
      const profileSaldo = document.getElementById('profileSaldo');
      const profileCoin = document.getElementById('profileCoin');
      const profileUsername = document.getElementById('profileUsername');

      const pendingBtn = document.getElementById('pendingBtn');
      const pendingPopup = document.getElementById('pendingPopup');
      const pendingListContainer = document.getElementById('pendingListContainer');
      const pendingCountSpan = document.getElementById('pendingCount');

      const depositTimerOverlay = document.getElementById('depositTimerOverlay');
      const closeTimerBtn = document.getElementById('closeTimerBtn');
      const cancelDepositBtn = document.getElementById('cancelDepositBtn');
      const closeDepositBtn = document.getElementById('closeDepositBtn');

      const timerMethodName = document.getElementById('timerMethodName');
      const timerAmount = document.getElementById('timerAmount');
      const timerFee = document.getElementById('timerFee');
      const timerGetBalance = document.getElementById('timerGetBalance');
      const timerBankLabel = document.getElementById('timerBankLabel');
      const timerBankValue = document.getElementById('timerBankValue');
      const timerAccountLabel = document.getElementById('timerAccountLabel');
      const timerAccountValue = document.getElementById('timerAccountValue');
      const timerNameLabel = document.getElementById('timerNameLabel');
      const timerNameValue = document.getElementById('timerNameValue');
      const timerCreatedAt = document.getElementById('timerCreatedAt');
      const timerExpiredAt = document.getElementById('timerExpiredAt');
      const timerStatus = document.getElementById('timerStatus');
      const timerCountdown = document.getElementById('timerCountdown');
      const timerQrContainer = document.getElementById('timerQrContainer');

      let methodsData = [];
      let selectedMethod = null;
      let profileData = null;
      let depositTimerData = null;
      let countdownInterval = null;

      function createEl(tag, options = {}) {
        const el = document.createElement(tag);
        if (options.classes) el.className = options.classes;
        if (options.attrs) {
          for (const [k, v] of Object.entries(options.attrs)) {
            if (v === false || v === null) continue;
            if (v === true) el.setAttribute(k, '');
            else el.setAttribute(k, v);
          }
        }
        if (options.text) el.textContent = options.text;
        if (options.html) el.innerHTML = options.html;
        return el;
      }

      function formatIDR(num) {
        return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);
      }

      function showStatusMessage(message, type = 'info') {
        depositResult.style.display = 'block';
        depositResult.innerHTML = '';
        const div = createEl('div', { classes: 'status-message' });
        if (type === 'pending') div.classList.add('status-pending');
        else if (type === 'success') div.classList.add('status-success');
        else if (type === 'cancel') div.classList.add('status-cancel');
        else if (type === 'error') div.classList.add('status-error');
        else div.style.color = '#475569';
        div.innerHTML = `<i class="fas fa-info-circle" aria-hidden="true"></i> ${message}`;
        depositResult.appendChild(div);
        depositResult.scrollIntoView({ behavior: 'smooth' });
      }

      function clearStatusMessage() {
        depositResult.style.display = 'none';
        depositResult.innerHTML = '';
      }

      async function fetchDepositMethods(type) {
        methodsList.innerHTML = '';
        const loadingText = createEl('p', { text: 'Memuat metode deposit...', attrs: { style: 'color:#64748b; font-style:italic; text-align:center; marginTop: 12px; userSelect: "none"' } });
        methodsList.appendChild(loadingText);
        try {
          const params = new URLSearchParams();
          if (type) params.append('type', type);

          const response = await fetch(`${API_BASE}/methode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          if (!response.ok) throw new Error('Gagal memuat metode deposit');
          const data = await response.json();
          if (!data.status || !data.data) throw new Error('Data metode deposit tidak valid');
          methodsData = data.data;
          renderMethodsList();
        } catch (err) {
          methodsList.innerHTML = '';
          const errorText = createEl('p', { text: 'Gagal memuat metode deposit. Silakan coba lagi.', attrs: { style: 'color:#b91c1c; text-align:center; marginTop: 12px; userSelect: "none"' } });
          methodsList.appendChild(errorText);
          methodsData = [];
          selectedMethod = null;
          updateSubmitButtonState();
        }
      }

      function renderMethodsList() {
        methodsList.innerHTML = '';
        if (methodsData.length === 0) {
          const noMethods = createEl('p', { text: 'Tidak ada metode deposit tersedia untuk jenis ini.', attrs: { style: 'color:#64748b; font-style:italic; text-align:center; marginTop: 12px; userSelect: "none"' } });
          methodsList.appendChild(noMethods);
          selectedMethod = null;
          updateSubmitButtonState();
          return;
        }
        methodsData.forEach((method, idx) => {
          const item = createEl('div', { classes: 'method-item', attrs: { role: 'listitem', tabindex: '0', 'data-index': idx, 'aria-label': `Metode deposit ${method.name}, tipe ${method.type}, biaya ${method.fee_persen}% plus Rp ${method.fee}` } });
          if (selectedMethod && selectedMethod.metode === method.metode) {
            item.classList.add('selected');
          }
          const img = createEl('img', {
            classes: 'method-img',
            attrs: { src: method.img_url || 'https://placehold.co/64x64?text=No+Image', alt: `Logo metode pembayaran ${method.name}` },
          });
          item.appendChild(img);

          const info = createEl('div', { classes: 'method-info' });
          const name = createEl('div', { classes: 'method-name', html: `${method.name} <i class="fas fa-check-circle" aria-hidden="true"></i>` });
          const type = createEl('div', { classes: 'method-type', text: `Tipe: ${method.type}` });
          const fee = createEl('div', { classes: 'method-fee', html: `<i class="fas fa-coins" aria-hidden="true"></i> Biaya: ${method.fee_persen}% + Rp ${method.fee}` });
          const minmax = createEl('div', { classes: 'method-minmax', text: `Min: Rp ${method.min} - Max: Rp ${method.max}` });
          info.appendChild(name);
          info.appendChild(type);
          info.appendChild(fee);
          info.appendChild(minmax);
          item.appendChild(info);

          item.addEventListener('click', () => {
            selectMethod(idx);
          });
          item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectMethod(idx);
            }
          });

          methodsList.appendChild(item);
        });
        if (!selectedMethod || !methodsData.find(m => m.metode === selectedMethod.metode)) {
          selectMethod(0);
        }
      }

      function selectMethod(idx) {
        if (idx < 0 || idx >= methodsData.length) return;
        selectedMethod = methodsData[idx];
        const items = methodsList.querySelectorAll('.method-item');
        items.forEach((item, i) => {
          if (i === idx) item.classList.add('selected');
          else item.classList.remove('selected');
        });
        updateSubmitButtonState();
        clearStatusMessage();
      }

      function updateSubmitButtonState() {
        const nominalVal = parseInt(nominalInput.value, 10);
        const isNominalValid = !isNaN(nominalVal) && nominalVal >= 500;
        const isMethodSelected = selectedMethod !== null;
        submitBtn.disabled = !(isNominalValid && isMethodSelected);
      }

      depositForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearStatusMessage();
        submitBtn.disabled = true;
        submitBtn.setAttribute('aria-busy', 'true');
        submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin btn-icon" aria-hidden="true"></i> Memproses...`;

        const nominalVal = parseInt(nominalInput.value, 10);
        if (isNaN(nominalVal) || nominalVal < 500) {
          showStatusMessage('Nominal deposit minimal Rp 500.', 'error');
          submitBtn.disabled = false;
          submitBtn.setAttribute('aria-busy', 'false');
          submitBtn.innerHTML = `<i class="fas fa-paper-plane btn-icon" aria-hidden="true"></i> Buat Permintaan Deposit`;
          return;
        }
        if (!selectedMethod) {
          showStatusMessage('Silakan pilih metode deposit.', 'error');
          submitBtn.disabled = false;
          submitBtn.setAttribute('aria-busy', 'false');
          submitBtn.innerHTML = `<i class="fas fa-paper-plane btn-icon" aria-hidden="true"></i> Buat Permintaan Deposit`;
          return;
        }

        try {
          const params = new URLSearchParams();
          params.append('nominal', nominalVal);
          params.append('type', depositTypeSelect.value);
          params.append('metode', selectedMethod.metode);

          const response = await fetch(`${API_BASE}/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          if (!response.ok) {
            const errData = await response.json().catch(() => null);
            throw new Error(errData?.message || 'Gagal membuat permintaan deposit');
          }
          const data = await response.json();
          if (!data.success || !data.data) {
            throw new Error(data.message || 'Gagal membuat permintaan deposit');
          }
          savePendingDeposit(data.data);
          openDepositTimer(data.data);
          updatePendingCount();
          depositForm.reset();
          selectedMethod = null;
          renderMethodsList();
          updateSubmitButtonState();
          clearStatusMessage();
        } catch (err) {
          showStatusMessage(err.message || 'Terjadi kesalahan saat membuat deposit.', 'error');
        } finally {
          submitBtn.disabled = false;
          submitBtn.setAttribute('aria-busy', 'false');
          submitBtn.innerHTML = `<i class="fas fa-paper-plane btn-icon" aria-hidden="true"></i> Buat Permintaan Deposit`;
        }
      });

      nominalInput.addEventListener('input', updateSubmitButtonState);
      depositTypeSelect.addEventListener('change', () => {
        selectedMethod = null;
        clearStatusMessage();
        updateSubmitButtonState();
        fetchDepositMethods(depositTypeSelect.value);
      });

      profileBtn.addEventListener('click', async () => {
        const expanded = profileBtn.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          closeProfilePopup();
        } else {
          await openProfilePopup();
        }
      });

      pendingBtn.addEventListener('click', () => {
        const expanded = pendingBtn.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          closePendingPopup();
        } else {
          openPendingPopup();
        }
      });

      document.addEventListener('click', (e) => {
        if (!profileBtn.contains(e.target) && !profilePopup.contains(e.target)) {
          closeProfilePopup();
        }
        if (!pendingBtn.contains(e.target) && !pendingPopup.contains(e.target)) {
          closePendingPopup();
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeProfilePopup();
          closePendingPopup();
          profileBtn.focus();
          pendingBtn.focus();
        }
      });

      async function openProfilePopup() {
        profileBtn.setAttribute('aria-expanded', 'true');
        profilePopup.classList.add('visible');
        profilePopup.focus();

        if (profileData) {
          fillProfileData(profileData);
          return;
        }
        try {
          const response = await fetch(PROFILE_API, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
          });
          if (!response.ok) throw new Error('Gagal memuat data profil');
          const data = await response.json();
          if (!data.success || !data.user) throw new Error('Data profil tidak valid');
          profileData = data.user;
          fillProfileData(profileData);
        } catch (err) {
          profileFullname.textContent = '-';
          profileUsernamePopup.textContent = '-';
          profileSaldo.textContent = '-';
          profileCoin.textContent = '-';
          profileUsername.textContent = 'User';
          alert('Gagal memuat data profil. Silakan coba lagi.');
          closeProfilePopup();
        }
      }

      function closeProfilePopup() {
        profileBtn.setAttribute('aria-expanded', 'false');
        profilePopup.classList.remove('visible');
      }

      function fillProfileData(user) {
        profileFullname.textContent = user.fullname || '-';
        profileUsernamePopup.textContent = user.username || '-';
        profileSaldo.textContent = formatIDR(user.saldo || 0);
        profileCoin.textContent = (user.coin != null) ? user.coin : '-';
        profileUsername.textContent = user.username || 'User';
        if (user.profileUrl) {
          const img = profileBtn.querySelector('img');
          img.src = user.profileUrl;
          img.alt = `Foto profil ${user.fullname || user.username || 'User'}`;
        }
      }

      function openPendingPopup() {
        pendingBtn.setAttribute('aria-expanded', 'true');
        pendingPopup.classList.add('visible');
        pendingPopup.focus();
        renderPendingDeposits();
      }

      function closePendingPopup() {
        pendingBtn.setAttribute('aria-expanded', 'false');
        pendingPopup.classList.remove('visible');
      }

      const LS_PENDING_DEPOSITS = 'pendingDeposits';

      function savePendingDeposit(deposit) {
        let pending = JSON.parse(localStorage.getItem(LS_PENDING_DEPOSITS) || '[]');
        pending = pending.filter(d => d.id !== deposit.id);
        pending.push(deposit);
        localStorage.setItem(LS_PENDING_DEPOSITS, JSON.stringify(pending));
        updatePendingCount();
      }

      function removePendingDeposit(id) {
        let pending = JSON.parse(localStorage.getItem(LS_PENDING_DEPOSITS) || '[]');
        pending = pending.filter(d => d.id !== id);
        localStorage.setItem(LS_PENDING_DEPOSITS, JSON.stringify(pending));
        updatePendingCount();
      }

      function getPendingDeposits() {
        return JSON.parse(localStorage.getItem(LS_PENDING_DEPOSITS) || '[]');
      }

      function updatePendingCount() {
        const pending = getPendingDeposits();
        pendingCountSpan.textContent = pending.length;
        if (pending.length === 0) {
          pendingCountSpan.style.display = 'none';
        } else {
          pendingCountSpan.style.display = 'inline-block';
        }
      }

      function renderPendingDeposits() {
        const pending = getPendingDeposits();
        pendingListContainer.innerHTML = '';
        if (pending.length === 0) {
          const emptyMsg = createEl('p', { classes: 'empty-message', text: 'Tidak ada deposit pending saat ini.' });
          pendingListContainer.appendChild(emptyMsg);
          return;
        }
        pending.forEach(deposit => {
          const row = createEl('div', { classes: 'deposit-row' });

          const metaContainer = createEl('div', {classes: 'deposit-meta'});
          const label = createEl('div', { classes: 'deposit-label', text: `ID: ${deposit.id}` });
          const value = createEl('div', { classes: 'deposit-value', text: `${formatIDR(deposit.nominal)} - ${deposit.status.toUpperCase()}` });
          metaContainer.appendChild(label);
          metaContainer.appendChild(value);
          row.appendChild(metaContainer);

          const buttonContainer = createEl('div', { classes: 'deposit-buttons-container' });

          const btnPayNow = createEl('button', { classes: 'pay-now-btn', text: 'Bayar Sekarang' });
          btnPayNow.title = `Bayar deposit ${deposit.id}`;
          btnPayNow.addEventListener('click', () => {
            closePendingPopup();
            openDepositTimer(deposit);
          });

          const btnCancel = createEl('button', { classes: 'cancel-btn', text: 'Batalkan' });
          btnCancel.title = `Batalkan deposit ${deposit.id}`;
          btnCancel.addEventListener('click', () => {
            cancelDeposit(deposit.id);
          });

          buttonContainer.appendChild(btnPayNow);
          buttonContainer.appendChild(btnCancel);
          row.appendChild(buttonContainer);
          pendingListContainer.appendChild(row);
        });
      }

      async function cancelDeposit(id) {
        if (!id) return;
        if (!confirm(`Batalkan deposit dengan ID ${id}?`)) return;
        try {
          const params = new URLSearchParams();
          params.append('trxid', id);
          const response = await fetch(`${API_BASE}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          });
          if (!response.ok) {
            const errData = await response.json().catch(() => null);
            throw new Error(errData?.message || 'Gagal membatalkan deposit');
          }
          const data = await response.json();
          if (!data.success) throw new Error(data.message || 'Gagal membatalkan deposit');
          alert('Deposit berhasil dibatalkan');
          removePendingDeposit(id);
          renderPendingDeposits();
          if (depositTimerData && depositTimerData.id === id) {
            closeDepositTimer();
          }
        } catch (err) {
          alert(err.message || 'Terjadi kesalahan saat membatalkan deposit.');
        }
      }

      function openDepositTimer(deposit) {
        depositTimerData = deposit;
        depositTimerOverlay.style.display = 'flex';
        updateDepositTimerUI();
        startCountdown();
      }

      function closeDepositTimer() {
        depositTimerOverlay.style.display = 'none';
        depositTimerData = null;
        stopCountdown();
      }

      function updateDepositTimerUI() {
        if (!depositTimerData) return;

        timerMethodName.textContent = depositTimerData.metode || 'Tidak diketahui';
        timerAmount.textContent = formatIDR(depositTimerData.nominal || 0);
        timerFee.textContent = formatIDR((depositTimerData.fee || 0) + (depositTimerData.tambahan || 0));
        timerGetBalance.textContent = formatIDR(depositTimerData.get_balance || 0);
        timerCreatedAt.textContent = depositTimerData.created_at || '-';
        timerExpiredAt.textContent = depositTimerData.expired_at || '-';

        timerBankLabel.style.display = 'none'; timerBankValue.style.display = 'none';
        timerAccountLabel.style.display = 'none'; timerAccountValue.style.display = 'none';
        timerNameLabel.style.display = 'none'; timerNameValue.style.display = 'none';

        if (depositTimerData.bank && depositTimerData.tujuan && depositTimerData.atas_nama) {
            timerBankLabel.textContent = 'Bank Tujuan';
            timerBankValue.textContent = depositTimerData.bank;
            timerAccountLabel.textContent = 'Nomor Rekening';
            timerAccountValue.textContent = depositTimerData.tujuan;
            timerNameLabel.textContent = 'Atas Nama';
            timerNameValue.textContent = depositTimerData.atas_nama;

            timerBankLabel.style.display = 'block'; timerBankValue.style.display = 'block';
            timerAccountLabel.style.display = 'block'; timerAccountValue.style.display = 'block';
            timerNameLabel.style.display = 'block'; timerNameValue.style.display = 'block';
        } else if (depositTimerData.bank && depositTimerData.nomor_va) {
            timerBankLabel.textContent = 'Bank VA';
            timerBankValue.textContent = depositTimerData.bank;
            timerAccountLabel.textContent = 'Nomor Virtual Account';
            timerAccountValue.textContent = depositTimerData.nomor_va;

            timerBankLabel.style.display = 'block'; timerBankValue.style.display = 'block';
            timerAccountLabel.style.display = 'block'; timerAccountValue.style.display = 'block';
        }

        timerStatus.textContent = `Status: ${depositTimerData.status.toUpperCase()}`;
        timerStatus.className = 'deposit-timer-status';
        if (['expired', 'cancel', 'cancell', 'failed'].includes(depositTimerData.status.toLowerCase())) {
            timerStatus.classList.add('deposit-timer-expired');
        }

        timerQrContainer.innerHTML = '';
        if (depositTimerData.qr_image) {
            const img = createEl('img', { attrs: { src: depositTimerData.qr_image, alt: 'QR Code untuk pembayaran deposit' } });
            timerQrContainer.appendChild(img);
        } else if (depositTimerData.url) {
            const link = createEl('a', { attrs: { href: depositTimerData.url, target: '_blank', rel: 'noopener noreferrer' }, html: `<i class="fas fa-external-link-alt" aria-hidden="true"></i> Link Pembayaran E-Wallet` });
            timerQrContainer.appendChild(link);
        }
      }

      function startCountdown() {
        stopCountdown();
        if (!depositTimerData || !depositTimerData.expired_at) {
          timerCountdown.textContent = '';
          return;
        }
        function updateCountdown() {
          const now = new Date();
          const expireDate = new Date(depositTimerData.expired_at.replace(' ', 'T'));
          const diff = expireDate - now;
          if (diff <= 0) {
            timerCountdown.textContent = 'Waktu pembayaran telah habis';
            timerStatus.textContent = 'Status: EXPIRED';
            timerStatus.classList.add('deposit-timer-expired');
            stopCountdown();
            updateLocalStorageStatus(depositTimerData.id, 'expired');
            return;
          }
          const minutes = Math.floor(diff / 60000);
          const seconds = Math.floor((diff % 60000) / 1000);
          timerCountdown.textContent = `Waktu tersisa: ${minutes.toString().padStart(2,'0')}:${seconds.toString().padStart(2,'0')}`;
        }
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
      }

      function stopCountdown() {
        if (countdownInterval) {
          clearInterval(countdownInterval);
          countdownInterval = null;
        }
      }

      async function updateLocalStorageStatus(id, newStatus) {
        let pending = getPendingDeposits();
        let changed = false;

        const updatedPending = [];
        for (const d of pending) {
            if (d.id === id) {
                if (d.status.toLowerCase() !== newStatus.toLowerCase()) {
                    d.status = newStatus.toLowerCase();
                    changed = true;
                }
            }
            updatedPending.push(d);
        }
        
        if (changed) {
            try {
                const params = new URLSearchParams();
                params.append('trxid', id);
                const response = await fetch(`${API_BASE}/status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data.success && data.data) {
                        const latestData = data.data;
                        const finalUpdatedPending = updatedPending.map(d => {
                            if (d.id === id) {
                                return {
                                    ...d,
                                    status: latestData.status.toLowerCase(),
                                    nominal: latestData.nominal,
                                    fee: latestData.fee_dari_api,
                                    get_balance: latestData.saldo_masuk,
                                    metode: latestData.metode,
                                    bank: latestData.bank || d.bank || null,
                                    tujuan: latestData.tujuan || d.tujuan || null,
                                    atas_nama: latestData.atas_nama || d.atas_nama || null,
                                    nomor_va: latestData.nomor_va || d.nomor_va || null,
                                    expired_at: latestData.expired_at || d.expired_at || null,
                                    created_at: latestData.created_at || d.created_at || null,
                                };
                            }
                            return d;
                        }).filter(d => !['success', 'cancel', 'cancell', 'expired', 'failed'].includes(d.status));
                        localStorage.setItem(LS_PENDING_DEPOSITS, JSON.stringify(finalUpdatedPending));
                        updatePendingCount();
                        renderPendingDeposits();
                        if (depositTimerData && depositTimerData.id === id) {
                            depositTimerData = { ...depositTimerData, ...latestData, status: latestData.status.toLowerCase() };
                            updateDepositTimerUI();
                        }
                    } else {
                        const filtered = updatedPending.filter(d => !['success', 'cancel', 'cancell', 'expired', 'failed'].includes(d.status));
                        localStorage.setItem(LS_PENDING_DEPOSITS, JSON.stringify(filtered));
                        updatePendingCount();
                        renderPendingDeposits();
                    }
                }
            } catch (err) {
                const filtered = updatedPending.filter(d => !['success', 'cancel', 'cancell', 'expired', 'failed'].includes(d.status));
                localStorage.setItem(LS_PENDING_DEPOSITS, JSON.stringify(filtered));
                updatePendingCount();
                renderPendingDeposits();
            }
        }
      }

      async function pollDepositStatus() {
        const pending = getPendingDeposits();
        if (pending.length === 0) return;
        for (const deposit of pending) {
          try {
            const params = new URLSearchParams();
            params.append('trxid', deposit.id);
            const response = await fetch(`${API_BASE}/status`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params.toString(),
            });
            if (!response.ok) continue;
            const data = await response.json();
            if (!data.success || !data.data) continue;
            const statusData = data.data;
            if (statusData.status && statusData.status.toLowerCase() !== deposit.status.toLowerCase()) {
              await updateLocalStorageStatus(deposit.id, statusData.status);
              if (depositTimerData && depositTimerData.id === deposit.id) {
                updateDepositTimerUI();
                if (['success', 'cancel', 'cancell', 'expired', 'failed'].includes(depositTimerData.status)) {
                  setTimeout(() => {
                    closeDepositTimer();
                  }, 3000);
                }
              }
            }
          } catch {
          }
        }
      }

      setInterval(pollDepositStatus, 3000);

      closeTimerBtn.addEventListener('click', () => {
        closeDepositTimer();
      });
      closeDepositBtn.addEventListener('click', () => {
        closeDepositTimer();
      });
      cancelDepositBtn.addEventListener('click', () => {
        if (!depositTimerData) return;
        cancelDeposit(depositTimerData.id);
      });

      fetchDepositMethods(depositTypeSelect.value);
      updatePendingCount();

      (async () => {
        try {
          const response = await fetch(PROFILE_API, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!data.success || !data.user) return;
          profileData = data.user;
          fillProfileData(profileData);
        } catch {}
      })();
    })();