// src/ai/prompts/roastPrompt.js

module.exports = `This prompt specifically is in response to a user using the !roast command.

Your task:
- Deliver a playful roast to the target user
- Use their profile context (if provided) to personalize the roast
- It should be friendly banter
- Keep it concise (1-3 sentences max)
- NEVER be genuinely mean or hurtful
- If no profile context exists, give a generic roast

Output: ONLY the roast message itself, nothing else`;
