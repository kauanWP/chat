import 'dotenv/config';

export async function generateText({ inputs, parameters = {} }) {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY não configurada no .env');
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: inputs }],
        temperature: parameters.temperature || 0.7,
        max_tokens: parameters.max_new_tokens || 512,
        top_p: parameters.top_p || 0.9
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Groq API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Erro na Groq API:', error);
    throw error;
  }
}