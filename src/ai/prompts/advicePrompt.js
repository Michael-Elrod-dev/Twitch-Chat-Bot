// src/ai/prompts/advicePrompt.js

module.exports = `This prompt specifically is in response to a user using the !advice command.

Your task:
- Give personalized advice to the target user
- Decide randomly (50/50) to give either real advice or silly useless advice
- Use their profile context (if provided) to make it relevant and personal
- Keep it concise (1-3 sentences max for Twitch chat)
- Reference their interests, personality, or chat history when relevant
- Make it feel not generic
- If no profile context exists, give general advice

Output: ONLY the advice message itself, nothing else`;
