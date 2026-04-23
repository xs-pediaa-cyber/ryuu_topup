        function drawVisor() {
            const canvas = document.getElementById('visor');
            if (!canvas || !canvas.getContext) return;
            
            const parentHead = canvas.parentElement;
            canvas.width = parentHead.clientWidth;
            canvas.height = parentHead.clientHeight;

            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            
            ctx.beginPath();
            ctx.moveTo(w * 0.1, h * 0.75);
            ctx.bezierCurveTo(w * 0.25, h * 1.06, w * 0.75, h * 1.06, w * 0.9, h * 0.75);
            ctx.lineTo(w * 0.9, h * 0.33);
            ctx.bezierCurveTo(w * 0.9, h * 0.25, w * 0.83, h * 0.16, w * 0.75, h * 0.16);
            ctx.lineTo(w * 0.25, h * 0.16);
            ctx.bezierCurveTo(w * 0.16, h * 0.16, w * 0.1, h * 0.25, w * 0.1, h * 0.33);
            ctx.closePath();

            ctx.fillStyle = '#2f3640';
            ctx.strokeStyle = 'rgba(245,246,250,0.8)';
            ctx.lineWidth = Math.max(1, w * 0.03);
            ctx.fill();
            ctx.stroke();
        }

        function animateCord() {
            const cordCanvas = document.getElementById('cord');
            if (!cordCanvas || !cordCanvas.getContext) return;

            const cordContainer = cordCanvas.parentElement;
            cordCanvas.width = cordContainer.clientWidth;
            cordCanvas.height = cordContainer.clientHeight;
            
            const ctx = cordCanvas.getContext('2d');
            const canvasWidth = cordCanvas.width;
            const canvasHeight = cordCanvas.height;

            const startX = canvasWidth * 0.95; 
            const startY = canvasHeight * 0.25; 

            const endX = canvasWidth * 0.05; 
            const endY = canvasHeight * 0.35;

            let controlY1 = canvasHeight * 0.05;
            let controlY2 = canvasHeight * 0.60;
            
            let y1Forward = true;
            let y2Forward = false;

            const amplitude1 = canvasHeight * 0.15;
            const amplitude2 = canvasHeight * 0.20;

            function animate() {
                requestAnimationFrame(animate);
                ctx.clearRect(0, 0, canvasWidth, canvasHeight);
                
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.bezierCurveTo(canvasWidth * 0.70, controlY1, canvasWidth * 0.35, controlY2, endX, endY);
                
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
                ctx.lineWidth = Math.max(3, canvasWidth * 0.02);
                ctx.lineCap = 'round';
                ctx.stroke();
            
                if (y1Forward) {
                    controlY1 += 0.3;
                    if (controlY1 >= canvasHeight * 0.05 + amplitude1) y1Forward = false;
                } else {
                    controlY1 -= 0.3;
                    if (controlY1 <= canvasHeight * 0.05 - amplitude1) y1Forward = true;
                }
                
                if (y2Forward) {
                    controlY2 += 0.4;
                    if (controlY2 >= canvasHeight * 0.60 + amplitude2) y2Forward = false;
                } else {
                    controlY2 -= 0.4;
                    if (controlY2 <= canvasHeight * 0.60 - amplitude2) y2Forward = true;
                }
            }
            animate();
        }
        
        function debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        function initializeAndResize() {
            drawVisor();
            animateCord();
        }
        
        const debouncedResize = debounce(initializeAndResize, 100);

        document.addEventListener('DOMContentLoaded', initializeAndResize);
        window.addEventListener('resize', debouncedResize);

          function goHome() {
              window.location.href = '/'; // Ganti '/' ke URL tujuan kalau beda
            }
        
            function reportIssue() {
              window.location.href = '/dashboard'; // Ganti '/report' sesuai rute report kamu
            }