const tabs = document.querySelectorAll('.auth-tab');
const forms = document.querySelectorAll('.auth-form');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        // Remove active class from all tabs and forms
        tabs.forEach(t => t.classList.remove('active'));
        forms.forEach(f => f.classList.remove('active'));
        
        // Add active class to clicked tab and corresponding form
        tab.classList.add('active');
        const tabName = tab.getAttribute('data-tab');
        document.getElementById(`${tabName}Form`).classList.add('active');
        
        // Clear any alerts when switching tabs
        hideAlert();
    });
});

// Switch between login and register
document.getElementById('switchToLogin').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('.auth-tab[data-tab="login"]').click();
});

document.getElementById('forgotPassword').addEventListener('click', (e) => {
    e.preventDefault();
    showAlert('Password reset instructions will be sent to your email if registered.', 'warning');
});

// Toggle password visibility
function togglePassword(inputId, icon) {
    const input = document.getElementById(inputId);
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// Form submission handling
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        usernameOrEmail: document.getElementById('loginUsernameOrEmail').value,
        password: document.getElementById('loginPassword').value
    };
    
    try {
        showAlert('Authenticating...', 'info');
        
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            showAlert('Login successful! Redirecting...', 'success');
            setTimeout(() => {
                window.location.href = data.redirectUrl;
            }, 1000);
        } else {
            showAlert(data.message || 'Invalid credentials. Please try again.', 'error');
        }
    } catch (error) {
        showAlert('Network error. Please try again.', 'error');
        console.error('Login error:', error);
    }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = {
        fullname: document.getElementById('registerFullname').value,
        username: document.getElementById('registerUsername').value,
        email: document.getElementById('registerEmail').value,
        nomor: document.getElementById('registerNomor').value,
        password: document.getElementById('registerPassword').value,
        profileUrl: document.getElementById('registerProfileUrl').value || undefined
    };
    
    try {
        showAlert('Creating your account...', 'info');
        
        const response = await fetch('/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        if (response.redirected) {
            window.location.href = response.url;
        } else {
            const data = await response.json();
            if (data.error) {
                showAlert(data.error, 'error');
            } else {
                showAlert('Registration successful! Redirecting to login...', 'success');
                setTimeout(() => {
                    document.querySelector('.auth-tab[data-tab="login"]').click();
                    document.getElementById('loginUsernameOrEmail').value = formData.email;
                }, 1500);
            }
        }
    } catch (error) {
        showAlert('An error occurred. Please try again.', 'error');
        console.error('Registration error:', error);
    }
});

// Social buttons functionality
document.querySelectorAll('.social-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const provider = e.currentTarget.classList.contains('google') ? 'Google' : 
                         e.currentTarget.classList.contains('facebook') ? 'Facebook' : 'Twitter';
        showAlert(`${provider} authentication will be available soon.`, 'warning');
    });
});

// Alert functions
function showAlert(message, type) {
    const alertBox = document.getElementById('alertBox');
    const alertMessage = alertBox.querySelector('.alert-message');
    const alertIcon = alertBox.querySelector('i');
    
    alertBox.className = 'alert';
    alertBox.classList.add(`alert-${type}`);
    alertMessage.textContent = message;
    
    // Set appropriate icon
    switch(type) {
        case 'success':
            alertIcon.className = 'fas fa-check-circle';
            break;
        case 'error':
            alertIcon.className = 'fas fa-exclamation-circle';
            break;
        case 'warning':
            alertIcon.className = 'fas fa-exclamation-triangle';
            break;
        default:
            alertIcon.className = 'fas fa-info-circle';
    }
    
    alertBox.style.display = 'flex';
    setTimeout(hideAlert, 5000);
}

function hideAlert() {
    document.getElementById('alertBox').style.display = 'none';
}
