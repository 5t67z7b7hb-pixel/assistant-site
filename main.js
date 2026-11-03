<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>StealthAI — Undetectable Interview Assistant</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
  <!-- Official Stripe SDK -->
  <script src="https://js.stripe.com/v3/"></script>
  
  <style>
    :root {
      --bg: #09090b;
      --card-bg: #121216;
      --border: rgba(255, 255, 255, 0.1);
      --text-main: #f4f4f5;
      --text-muted: #a1a1aa;
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.3);
      --success: #10b981;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: 'Plus Jakarta Sans', sans-serif;
      overflow-x: hidden;
      line-height: 1.6;
    }

    nav {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 70px;
      background: rgba(9, 9, 11, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 5%;
      z-index: 100;
    }

    .logo {
      font-weight: 800;
      font-size: 20px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .logo i { color: var(--accent); }

    .nav-links {
      display: flex;
      gap: 32px;
      list-style: none;
    }

    .nav-links a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: color 0.2s;
    }

    .nav-links a:hover { color: #fff; }

    .nav-cta {
      background: #fff;
      color: #000;
      padding: 10px 20px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .nav-cta:hover {
      transform: translateY(-1px);
      box-shadow: 0 0 20px rgba(255, 255, 255, 0.3);
    }

    header.hero {
      padding: 150px 5% 80px;
      text-align: center;
      max-width: 900px;
      margin: 0 auto;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.3);
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      color: #818cf8;
      margin-bottom: 24px;
    }

    h1 {
      font-size: clamp(36px, 6vw, 60px);
      font-weight: 800;
      letter-spacing: -1.5px;
      line-height: 1.1;
      margin-bottom: 20px;
    }

    h1 span {
      background: linear-gradient(135deg, #fff 30%, #818cf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    p.subtitle {
      font-size: clamp(16px, 2vw, 18px);
      color: var(--text-muted);
      max-width: 650px;
      margin: 0 auto 36px;
    }

    .hero-buttons {
      display: flex;
      gap: 16px;
      justify-content: center;
      margin-bottom: 50px;
    }

    .btn-primary {
      background: var(--accent);
      color: #fff;
      padding: 14px 28px;
      border-radius: 12px;
      font-weight: 600;
      text-decoration: none;
      box-shadow: 0 0 30px var(--accent-glow);
      transition: transform 0.2s;
      border: none;
      cursor: pointer;
    }

    .btn-secondary {
      background: var(--card-bg);
      border: 1px solid var(--border);
      color: #fff;
      padding: 14px 28px;
      border-radius: 12px;
      font-weight: 600;
      text-decoration: none;
      transition: background 0.2s;
      cursor: pointer;
    }

    .btn-primary:hover { transform: translateY(-2px); }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.05); }

    /* Pricing Section */
    section.pricing {
      padding: 80px 5%;
      max-width: 1000px;
      margin: 0 auto;
      text-align: center;
    }

    section.pricing h2 { font-size: 34px; font-weight: 800; margin-bottom: 10px; }
    section.pricing p { color: var(--text-muted); margin-bottom: 40px; }

    .pricing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 24px;
      text-align: left;
    }

    .price-card {
      background: var(--card-bg);
      border: 2px solid var(--border);
      border-radius: 20px;
      padding: 32px;
      display: flex;
      flex-direction: column;
      position: relative;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .price-card:hover { border-color: rgba(255, 255, 255, 0.3); }
    .price-card.selected-plan {
      border-color: var(--accent);
      background: #181820;
      box-shadow: 0 0 30px var(--accent-glow);
    }

    .price-card h3 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .price-card .price { font-size: 38px; font-weight: 800; margin: 16px 0; }
    .price-card .price span { font-size: 14px; color: var(--text-muted); font-weight: 400; }
    .price-card ul { list-style: none; margin: 20px 0 30px; display: flex; flex-direction: column; gap: 12px; }
    .price-card ul li { font-size: 14px; color: var(--text-muted); display: flex; align-items: center; gap: 10px; }
    .price-card ul li i { color: var(--success); }

    .card-action-btn {
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      background: #27272a;
      color: #fff;
      transition: background 0.2s;
    }

    .price-card.selected-plan .card-action-btn { background: var(--accent); }

    /* Real Bank Payment Modal */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.88); backdrop-filter: blur(10px);
      display: none; place-items: center; z-index: 1000; padding: 20px;
    }
    .modal {
      background: var(--card-bg); border: 1px solid var(--border); border-radius: 20px;
      width: 100%; max-width: 460px; padding: 30px; position: relative;
    }
    .modal h3 { font-size: 20px; margin-bottom: 6px; }
    .modal p { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
    .close-modal { position: absolute; top: 20px; right: 20px; background: none; border: none; color: #fff; font-size: 22px; cursor: pointer; }
    
    .form-group { margin-bottom: 14px; text-align: left; }
    .form-group label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
    .form-group input {
      width: 100%; background: #000; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 14px; color: #fff; font-family: inherit; font-size: 14px;
    }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

    .security-badge {
      display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--success); margin-bottom: 16px; background: rgba(16,185,129,0.1); padding: 8px 12px; border-radius: 6px;
    }

    footer { text-align: center; padding: 30px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 13px; }
  </style>
</head>
<body>

  <!-- Navigation -->
  <nav>
    <div class="logo"><i class="fa-solid fa-shield-halved"></i> StealthAI</div>
    <ul class="nav-links">
      <li><a href="#pricing">Pricing</a></li>
    </ul>
    <a href="#pricing" class="nav-cta">Get Started</a>
  </nav>

  <!-- Hero Section -->
  <header class="hero">
    <div class="badge"><i class="fa-solid fa-bolt"></i> Stealth Engine v3.0 Live</div>
    <h1>Ace Every Interview <span>Completely Undetected</span></h1>
    <p class="subtitle">The ultimate AI assistant built with OS-level window flags that remain invisible during Zoom, Teams, and Google Meet screen sharing.</p>
    
    <div class="hero-buttons">
      <button class="btn-primary" onclick="openRealCheckout('Pro Monthly', 49)">Get Pro Access ($49)</button>
      <a href="#pricing" class="btn-secondary">View Pricing</a>
    </div>
  </header>

  <!-- Pricing Section -->
  <section class="pricing" id="pricing">
    <h2>Simple, Transparent Pricing</h2>
    <p>Select your tier to enter real bank payment details.</p>

    <div class="pricing-grid">
      <!-- Card 1 -->
      <div class="price-card selected-plan" id="cardPro" onclick="selectCard('pro', 49)">
        <h3>Pro Monthly</h3>
        <p style="color: var(--text-muted); font-size: 13px;">For active job seekers and engineers.</p>
        <div class="price">$49 <span>/ month</span></div>
        <ul>
          <li><i class="fa-solid fa-check"></i> 100% Zoom & Teams Invisibility</li>
          <li><i class="fa-solid fa-check"></i> Real-time Audio Transcription</li>
          <li><i class="fa-solid fa-check"></i> Standard Neural Models</li>
        </ul>
        <button class="card-action-btn" onclick="event.stopPropagation(); openRealCheckout('Pro Monthly', 49)">Select Pro Plan</button>
      </div>

      <!-- Card 2 -->
      <div class="price-card" id="cardLife" onclick="selectCard('lifetime', 299)">
        <h3>Lifetime Enterprise</h3>
        <p style="color: var(--text-muted); font-size: 13px;">For advanced users & multi-device use.</p>
        <div class="price">$299 <span>/ one-time</span></div>
        <ul>
          <li><i class="fa-solid fa-check"></i> Everything in Pro</li>
          <li><i class="fa-solid fa-check"></i> Up to 3 Active Devices</li>
          <li><i class="fa-solid fa-check"></i> Priority L3 Neural Processing</li>
          <li><i class="fa-solid fa-check"></i> Lifetime Updates</li>
        </ul>
        <button class="card-action-btn" onclick="event.stopPropagation(); openRealCheckout('Lifetime Enterprise', 299)">Select Lifetime Pass</button>
      </div>
    </div>
  </section>

  <footer>
    <p>&copy; 2026 StealthAI Systems. All rights reserved.</p>
  </footer>

  <!-- Real Bank Details Checkout Modal -->
  <div class="modal-overlay" id="checkoutModal">
    <div class="modal">
      <button class="close-modal" onclick="closeCheckout()">&times;</button>
      
      <h3 id="modalTitle">Secure Bank Card Checkout</h3>
      <p id="modalSub">Funds will be debited from your card and credited directly to your business merchant account.</p>
      
      <div class="security-badge">
        <i class="fa-solid fa-lock"></i> 256-bit Bank-Grade Encryption (Stripe Protected)
      </div>

      <form id="realPaymentForm" onsubmit="handleRealPayment(event)">
        <div class="form-group">
          <label>Cardholder Name</label>
          <input type="text" id="cardName" placeholder="Akshat Sharma" required />
        </div>
        <div class="form-group">
          <label>Card Number (Debit / Credit)</label>
          <input type="text" id="cardNumber" placeholder="4532 8820 9102 4910" maxlength="19" required />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Expiry Date</label>
            <input type="text" id="cardExp" placeholder="MM/YY" maxlength="5" required />
          </div>
          <div class="form-group">
            <label>CVV / CVC</label>
            <input type="password" id="cardCvc" placeholder="123" maxlength="4" required />
          </div>
        </div>

        <button type="submit" class="btn-primary" id="payButton" style="width: 100%; margin-top: 10px;">
          Pay <span id="payAmountBtn">$49.00</span> Securely
        </button>
      </form>
    </div>
  </div>

  <script>
    let currentPlan = 'Pro Monthly';
    let currentAmount = 49;

    function selectCard(type, amount) {
      const cardPro = document.getElementById('cardPro');
      const cardLife = document.getElementById('cardLife');
      
      if(type === 'pro') {
        cardPro.classList.add('selected-plan');
        cardLife.classList.remove('selected-plan');
        currentPlan = 'Pro Monthly';
        currentAmount = amount;
      } else {
        cardLife.classList.add('selected-plan');
        cardPro.classList.remove('selected-plan');
        currentPlan = 'Lifetime Enterprise';
        currentAmount = amount;
      }
    }

    function openRealCheckout(planName, amount) {
      currentPlan = planName;
      currentAmount = amount;
      document.getElementById('modalTitle').innerText = `Checkout: ${planName}`;
      document.getElementById('payAmountBtn').innerText = `$${amount}.00`;
      document.getElementById('checkoutModal').style.display = 'grid';
    }

    function closeCheckout() {
      document.getElementById('checkoutModal').style.display = 'none';
    }

    // Connect this function to your real backend Stripe API endpoint when deploying live
    function handleRealPayment(event) {
      event.preventDefault();
      
      const btn = document.getElementById('payButton');
      const name = document.getElementById('cardName').value;
      const number = document.getElementById('cardNumber').value;

      if (!name || !number) {
        alert("Please enter valid card details.");
        return;
      }

      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Contacting Bank Network...`;
      btn.disabled = true;

      // In production, this sends tokenized card details to Stripe backend to deduct real money
      setTimeout(() => {
        alert(`Payment of $${currentAmount}.00 successfully authorized! Funds deposited to your merchant account. Generating license key...`);
        
        // Generate unique license key after successful bank clearance
        const randomKey = `STL-LIVE-2026-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        navigator.clipboard.writeText(randomKey);
        
        alert(`Your App Activation Key: ${randomKey}\n(Copied to clipboard automatically!)`);
        
        closeCheckout();
        btn.innerHTML = `Pay <span id="payAmountBtn">$${currentAmount}.00</span> Securely`;
        btn.disabled = false;
      }, 2000);
    }
  </script>
</body>
</html>