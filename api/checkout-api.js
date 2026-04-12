// api/checkout.js - Vercel Serverless Function
// Stripe Checkout Session 作成エンドポイント

export default async function handler(req, res) {
  // CORS設定
  res.setHeader('Access-Control-Allow-Origin', 'https://luxepartycom.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // OPTIONSリクエスト（プリフライト）への対応
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  const stripe_sk = process.env.STRIPE_SECRET_KEY;
  if (!stripe_sk) {
    return res.status(500).json({ ok: false, message: 'Stripe設定がありません' });
  }

  const { event_id, event_name, name, email, gender, invited_by, amount } = req.body;

  if (!event_id || !name || !email || !amount || amount <= 0) {
    return res.status(400).json({ ok: false, message: 'パラメータ不足' });
  }

  const successUrl = 'https://luxepartycom.github.io/event-system/checkout.html?session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl  = 'https://luxepartycom.github.io/event-system/index.html?e=' + event_id + '&type=paid';

  const params = new URLSearchParams({
    'mode': 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': 'jpy',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': (event_name || 'イベント') + ' 入場料',
    'line_items[0][quantity]': '1',
    'customer_email': email,
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    'metadata[event_id]': event_id,
    'metadata[name]': name,
    'metadata[email]': email,
    'metadata[gender]': gender || '',
    'metadata[invited_by]': invited_by || '',
    'metadata[amount]': String(amount),
  });

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(stripe_sk + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await stripeRes.json();

    if (data.error) {
      return res.status(400).json({ ok: false, message: 'Stripe: ' + data.error.message });
    }

    return res.status(200).json({ ok: true, checkout_url: data.url, session_id: data.id });

  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Stripe接続エラー: ' + err.message });
  }
}
