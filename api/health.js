module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    status: 'ok',
    runtime: 'vercel',
    model: 'gemini-2.5-flash'
  });
};
