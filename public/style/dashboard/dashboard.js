        document.addEventListener('DOMContentLoaded', () => {
            const body = document.body;
            const mainHeader = document.getElementById('main-header');
            const themeToggle = document.getElementById('theme-toggle');
            const themeToggleIcon = themeToggle.querySelector('i');
            const profileToggle = document.getElementById('profile-toggle');
            const profilePopup = document.getElementById('profile-popup');
            const notificationToggle = document.getElementById('notification-toggle');
            const notificationPopup = document.getElementById('notification-popup');
            const notificationMessage = document.getElementById('notification-message');
            const themeToggleInPopupButton = document.getElementById('theme-toggle-in-popup-button');

            const popupProfileFullname = document.getElementById('popup-profile-fullname');
            const popupProfileUsername = document.getElementById('popup-profile-username');
            const popupProfileSaldo = document.getElementById('popup-profile-saldo');
            const popupProfileCoin = document.getElementById('popup-profile-coin');
            const profileImg = profilePopup.querySelector('.profile-header img');

            const historyListContainer = document.getElementById('history-list');

            const bannerSlides = document.querySelectorAll('.banner-slide');
            const bannerCarousel = document.getElementById('banner-carousel');
            const bannerIndicatorsContainer = document.getElementById('banner-indicators');
            let currentSlideIndex = 0;
            let bannerInterval;

            let cachedProfileData = null;
            let cachedHistoryData = null;

            const savedTheme = localStorage.getItem('theme');
            if (savedTheme) {
                body.classList.add(savedTheme);
                updateThemeToggleIcon(savedTheme);
            } else {
                body.classList.add('dark-mode');
                localStorage.setItem('theme', 'dark-mode');
                updateThemeToggleIcon('dark-mode');
            }

            function updateThemeToggleIcon(theme) {
                if (theme === 'light-mode') {
                    themeToggleIcon.classList.replace('fa-sun', 'fa-moon');
                    if (themeToggleInPopupButton) themeToggleInPopupButton.innerHTML = '<i class="fas fa-moon"></i> Mode Terang';
                } else {
                    themeToggleIcon.classList.replace('fa-moon', 'fa-sun');
                    if (themeToggleInPopupButton) themeToggleInPopupButton.innerHTML = '<i class="fas fa-sun"></i> Mode Gelap';
                }
            }

            function toggleTheme() {
                if (body.classList.contains('dark-mode')) {
                    body.classList.replace('dark-mode', 'light-mode');
                    localStorage.setItem('theme', 'light-mode');
                    updateThemeToggleIcon('light-mode');
                } else {
                    body.classList.replace('light-mode', 'dark-mode');
                    localStorage.setItem('theme', 'dark-mode');
                    updateThemeToggleIcon('dark-mode');
                }
            }

            themeToggle.addEventListener('click', toggleTheme);
            if (themeToggleInPopupButton) {
                themeToggleInPopupButton.addEventListener('click', toggleTheme);
            }

            function formatRupiah(amount) {
                return new Intl.NumberFormat('id-ID', {
                    style: 'currency',
                    currency: 'IDR',
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0
                }).format(amount);
            }

            async function fetchUserProfile() {
                try {
                    const response = await fetch('/profile/users');
                    if (!response.ok) {
                        if (response.status === 404) {
                            throw new Error('Pengguna tidak ditemukan. Silakan login kembali.');
                        }
                        throw new Error(`Gagal mengambil data pengguna: ${response.statusText}`);
                    }
                    const data = await response.json();
                    if (data.success && data.user) {
                        cachedProfileData = data.user;
                        updateProfileUI();
                        updateNotificationUI();
                    } else {
                        throw new Error(data.message || 'Gagal mengambil data pengguna.');
                    }
                } catch (error) {
                    console.error('Error saat mengambil profil pengguna:', error);
                    cachedProfileData = null;
                    updateProfileUI();
                    updateNotificationUI();
                }
            }

            function updateProfileUI() {
                if (cachedProfileData) {
                    const user = cachedProfileData;
                    profileImg.src = user.profileUrl || 'https://i.pinimg.com/236x/a2/80/e2/a280e2a50bf6240f29b49a72875adee5.jpg';
                    
                    popupProfileFullname.innerHTML = '';
                    popupProfileFullname.textContent = user.fullname || 'Pengguna Tidak Dikenal';

                    if (user.isVerified) {
                        const verifiedIcon = document.createElement('i');
                        verifiedIcon.classList.add('fas', 'fa-check-circle', 'verified-badge');
                        popupProfileFullname.appendChild(verifiedIcon);
                    }

                    popupProfileUsername.textContent = `@${user.username || 'unknown_user'}`;
                    popupProfileSaldo.textContent = formatRupiah(user.saldo || 0);
                    popupProfileCoin.textContent = (user.coin || 0).toLocaleString('id-ID');
                } else {
                    profileImg.src = 'https://i.pinimg.com/236x/a2/80/e2/a280e2a50bf6240f29b49a72875adee5.jpg';
                    popupProfileFullname.innerHTML = 'Tidak Login';
                    popupProfileUsername.textContent = '@tamu';
                    popupProfileSaldo.textContent = 'Rp 0';
                    popupProfileCoin.textContent = '0';
                }
            }

            function updateNotificationUI() {
                if (cachedProfileData && cachedProfileData.isVerified) {
                    notificationMessage.classList.remove('warning');
                    notificationMessage.classList.add('success');
                    notificationMessage.innerHTML = `
                        <i class="fas fa-check-circle"></i>
                        <span>Akun anda sudah terverifikasi. Anda dapat menggunakan layanan API kami.</span>
                    `;
                } else {
                    notificationMessage.classList.remove('success');
                    notificationMessage.classList.add('warning');
                    notificationMessage.innerHTML = `
                        <i class="fas fa-exclamation-circle"></i>
                        <span>Akun belum terverifikasi. Silakan <a href="/profile">verifikasi</a> di profil.</span>
                    `;
                }
            }

            async function fetchHistoryData() {
                try {
                    const response = await fetch('/history/all');
                    if (!response.ok) {
                        throw new Error(`Gagal mengambil riwayat transaksi: ${response.statusText}`);
                    }
                    const data = await response.json();
                    cachedHistoryData = data;
                    updateHistoryUI();
                } catch (error) {
                    console.error('Error saat mengambil riwayat transaksi:', error);
                    cachedHistoryData = null;
                    updateHistoryUI();
                }
            }

            function updateHistoryUI() {
                historyListContainer.innerHTML = '';
                if (cachedHistoryData && cachedHistoryData.success && cachedHistoryData.history && cachedHistoryData.history.length > 0) {
                    const sortedHistory = cachedHistoryData.history.sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
                    const latest5History = sortedHistory.slice(0, 5);
                    
                    latest5History.forEach(item => {
                        const historyItem = document.createElement('div');
                        historyItem.className = 'history-item';
                        let statusClass = item.status.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (statusClass.includes('saldo')) statusClass = 'gagal';

                        let activityIconHtml = '';
                        let statusIconHtml = '';
                        let nominalSign = '';
                        let nominalClass = '';

                        if (item.aktivitas.toLowerCase().includes('deposit')) {
                            activityIconHtml = '<i class="fas fa-wallet"></i>';
                            nominalSign = '+';
                            nominalClass = 'nominal-plus';
                        } else if (item.aktivitas.toLowerCase().includes('order') || item.aktivitas.toLowerCase().includes('buy panel') || item.aktivitas.toLowerCase().includes('upgrade')) {
                            activityIconHtml = '<i class="fas fa-shopping-cart"></i>';
                            nominalSign = '-';
                            nominalClass = 'nominal-minus';
                        } else if (item.aktivitas.toLowerCase().includes('tukar coin ke saldo')) {
                             activityIconHtml = '<i class="fas fa-exchange-alt"></i>';
                             nominalSign = '+';
                             nominalClass = 'nominal-plus';
                        } else {
                            activityIconHtml = '<i class="fas fa-info-circle"></i>';
                        }

                        const lowerCaseStatus = item.status.toLowerCase();
                        if (lowerCaseStatus.includes('sukses') || lowerCaseStatus.includes('completed')) {
                            statusIconHtml = '<i class="fas fa-check-circle"></i>';
                        } else if (lowerCaseStatus.includes('pending')) {
                            statusIconHtml = '<i class="fas fa-clock"></i>';
                        } else if (lowerCaseStatus.includes('gagal') || lowerCaseStatus.includes('failed') || lowerCaseStatus.includes('tidak cukup') || lowerCaseStatus.includes('error')) {
                            statusIconHtml = '<i class="fas fa-times-circle"></i>';
                        } else if (lowerCaseStatus.includes('cancell') || lowerCaseStatus.includes('cancel')) {
                            statusIconHtml = '<i class="fas fa-ban"></i>';
                        } else {
                            statusIconHtml = '<i class="fas fa-info-circle"></i>';
                        }

                        const formattedDate = new Date(item.tanggal).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

                        const historyHeader = document.createElement('div');
                        historyHeader.className = 'history-header';
                        historyHeader.innerHTML = `
                            <div class="activity-info">
                                ${activityIconHtml}
                                <span>${item.aktivitas}</span>
                            </div>
                            <span class="status ${statusClass}">
                                ${statusIconHtml} ${item.status}
                            </span>
                        `;
                        historyItem.appendChild(historyHeader);

                        const detailsDiv = document.createElement('div');
                        detailsDiv.className = 'details';
                        detailsDiv.innerHTML = `
                            <p>Nominal: <span class="nominal-value ${nominalClass}">${nominalSign} ${formatRupiah(item.nominal || 0)}</span></p>
                            <p>Kode: ${item.code || '-'}</p>
                            <p>Tanggal: ${formattedDate}</p>
                            ${item.notes ? `<p>Catatan: ${item.notes}</p>` : ''}
                        `;
                        historyItem.appendChild(detailsDiv);

                        if (item.aktivitas.toLowerCase() === 'deposit' && item.status.toLowerCase() === 'pending') {
                            const actionDiv = document.createElement('div');
                            actionDiv.className = 'history-actions';
                            const cancelButton = document.createElement('button');
                            cancelButton.className = 'cancel-deposit-btn';
                            cancelButton.textContent = 'Batalkan';
                            
                            cancelButton.addEventListener('click', () => {
                                cancelDeposit(item.code);
                            });
                            actionDiv.appendChild(cancelButton);
                            historyItem.appendChild(actionDiv);
                        }
                        historyListContainer.appendChild(historyItem);
                    });
                } else {
                    historyListContainer.innerHTML = '<p class="no-history">Tidak ada riwayat transaksi.</p>';
                }
            }

            async function cancelDeposit(trxid) {
                if (!trxid) {
                    alert('ID transaksi tidak ditemukan.');
                    return;
                }
                if (!confirm(`Batalkan deposit dengan ID ${trxid}?`)) {
                    return;
                }
                try {
                    const params = new URLSearchParams();
                    params.append('trxid', trxid);

                    const response = await fetch('/deposit/cancel', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: params.toString(),
                    });

                    const data = await response.json();

                    if (response.ok && data.success) {
                        alert('Deposit berhasil dibatalkan!');
                        await fetchHistoryData(); 
                    } else {
                        alert(`Gagal membatalkan deposit: ${data.message || 'Terjadi kesalahan tidak dikenal.'}`);
                    }
                } catch (error) {
                    console.error('Error canceling deposit:', error);
                    alert('Terjadi kesalahan saat membatalkan deposit. Coba lagi nanti.');
                }
            }

            async function initializeData() {
                await Promise.all([fetchUserProfile(), fetchHistoryData()]);
            }

            function startDataRefresh() {
                setInterval(async () => {
                    await Promise.all([fetchUserProfile(), fetchHistoryData()]);
                }, 1000); 
            }

            initializeData().then(() => {
                startDataRefresh();
            });

            function showPopup(popupElement) {
                popupElement.classList.remove('hide-anim');
                popupElement.classList.add('show');
            }

            function hidePopup(popupElement) {
                popupElement.classList.remove('show');
                popupElement.classList.add('hide-anim');
                popupElement.addEventListener('transitionend', function handler() {
                    popupElement.classList.remove('hide-anim');
                    popupElement.removeEventListener('transitionend', handler);
                }, { once: true });
            }

            profileToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (profilePopup.classList.contains('show')) {
                    hidePopup(profilePopup);
                } else {
                    showPopup(profilePopup);
                    hidePopup(notificationPopup);
                }
            });

            notificationToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (notificationPopup.classList.contains('show')) {
                    hidePopup(notificationPopup);
                } else {
                    showPopup(notificationPopup);
                    hidePopup(profilePopup);
                }
            });

            document.addEventListener('click', e => {
                if (profilePopup.classList.contains('show') && !profilePopup.contains(e.target) && !profileToggle.contains(e.target)) {
                    hidePopup(profilePopup);
                }
                if (notificationPopup.classList.contains('show') && !notificationPopup.contains(e.target) && !notificationToggle.contains(e.target)) {
                    hidePopup(notificationPopup);
                }
            });

            window.addEventListener('scroll', () => {
                if (window.scrollY > 50) {
                    mainHeader.classList.add('scrolled');
                } else {
                    mainHeader.classList.remove('scrolled');
                }
            });

            function showSlide(index) {
                bannerSlides.forEach((slide, i) => {
                    slide.classList.remove('active');
                    if (i === index) {
                        slide.classList.add('active');
                    }
                });
                bannerIndicatorsContainer.querySelectorAll('.banner-indicator').forEach((indicator, i) => {
                    indicator.classList.remove('active');
                    if (i === index) {
                        indicator.classList.add('active');
                    }
                });
            }

            function nextSlide() {
                currentSlideIndex = (currentSlideIndex + 1) % bannerSlides.length;
                showSlide(currentSlideIndex);
            }

            function startBannerCarousel() {
                bannerIndicatorsContainer.innerHTML = '';
                bannerSlides.forEach((_, i) => {
                    const indicator = document.createElement('div');
                    indicator.classList.add('banner-indicator');
                    indicator.addEventListener('click', () => {
                        clearInterval(bannerInterval);
                        currentSlideIndex = i;
                        showSlide(currentSlideIndex);
                        bannerInterval = setInterval(nextSlide, 4000);
                    });
                    bannerIndicatorsContainer.appendChild(indicator);
                });

                showSlide(currentSlideIndex);
                bannerInterval = setInterval(nextSlide, 4000);
            }

            startBannerCarousel();

            const currentPath = window.location.pathname;
            document.querySelectorAll('.sidebar a, .bottom-nav a').forEach(link => {
                link.classList.remove('active');
                const linkHref = link.getAttribute('href');

                if (linkHref === '/dashboard' && (currentPath === '/dashboard' || currentPath === '/')) {
                    link.classList.add('active');
                } else if (linkHref === currentPath) {
                    link.classList.add('active');
                }
            });
        });