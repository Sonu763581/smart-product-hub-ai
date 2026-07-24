export default {
  async fetch(request, env) {
    // Handle CORS preflight request
    if (request.method === "OPTIONS") {
      return handleCorsPreflight();
    }

    if (request.method !== "POST") {
      return createJsonResponse(
        {
          success: false,
          error: "Only POST method is allowed"
        },
        405
      );
    }

    let payload;

    try {
      payload = await request.json();
    } catch (e) {
      return createJsonResponse(
        {
          success: false,
          error: "Invalid JSON payload in request body"
        },
        400
      );
    }

    const { title, prompt, mode = "publish", postId } = payload;

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return createJsonResponse(
        {
          success: false,
          error: "Field 'prompt' is required and must be a non-empty string"
        },
        400
      );
    }

    if (mode !== "publish" && mode !== "update") {
      return createJsonResponse(
        {
          success: false,
          error: "Field 'mode' must be either 'publish' or 'update'"
        },
        400
      );
    }

    if (
      mode === "update" &&
      (!postId || typeof postId !== "string" || !postId.trim())
    ) {
      return createJsonResponse(
        {
          success: false,
          error: "Field 'postId' is required when mode is 'update'"
        },
        400
      );
    }

    const missingEnv = checkMissingEnvVars(env);

    if (missingEnv.length > 0) {
      return createJsonResponse(
        {
          success: false,
          error: `Missing environment variables: ${missingEnv.join(", ")}`
        },
        500
      );
    }

    try {
      const accessToken = await getGoogleAccessToken(env);

      const articleData = await generateArticleWithGemini(
        env,
        title,
        prompt
      );

      const bloggerResult = await executeBloggerOperation(
        env,
        accessToken,
        articleData,
        mode,
        postId
      );

      return createJsonResponse(
        {
          success: true,
          title: bloggerResult.title,
          url: bloggerResult.url,
          postId: bloggerResult.postId
        },
        200
      );
    } catch (error) {
      return createJsonResponse(
        {
          success: false,
          error: error.message || "An unexpected internal server error occurred"
        },
        500
      );
    }
  }
};

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400"
    }
  });
}

function checkMissingEnvVars(env) {
  const required = [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "BLOGGER_REFRESH_TOKEN",
    "GEMINI_API_KEY",
    "BLOG_ID"
  ];

  const missing = [];

  for (const key of required) {
    if (!env[key] || typeof env[key] !== "string" || !env[key].trim()) {
      missing.push(key);
    }
  }

  return missing;
}

function createJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

async function fetchWithRetryAndTimeout(
  url,
  options = {},
  retries = 2,
  backoff = 1000,
  timeoutMs = 25000
) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return response;
      }

      // Do NOT retry authentication failures, client errors,
      // or resource errors (400-499 except 429)
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        return response;
      }

      if (attempt === retries) {
        return response;
      }
    } catch (err) {
      clearTimeout(timeoutId);

      if (attempt === retries) {
        if (err.name === "AbortError") {
          throw new Error(
            `Network request timed out after ${timeoutMs}ms`
          );
        }

        throw err;
      }
    }

    await new Promise((resolve) =>
      setTimeout(resolve, backoff * Math.pow(2, attempt))
    );
  }
}

async function getGoogleAccessToken(env) {
  const tokenUrl = "https://oauth2.googleapis.com/token";

  const params = new URLSearchParams({
    client_id: env.CLIENT_ID.trim(),
    client_secret: env.CLIENT_SECRET.trim(),
    refresh_token: env.BLOGGER_REFRESH_TOKEN.trim(),
    grant_type: "refresh_token"
  });

  const response = await fetchWithRetryAndTimeout(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const data = await response.json();

  if (!response.ok) {
    const errorDetails =
      data.error_description || data.error || response.statusText;

    throw new Error(
      `Google OAuth Refresh Error [${response.status}]: ${errorDetails}`
    );
  }

  if (
    !data.access_token ||
    typeof data.access_token !== "string" ||
    !data.access_token.trim()
  ) {
    throw new Error(
      "Google OAuth response did not contain a valid access_token"
    );
  }

  return data.access_token.trim();
}

async function generateArticleWithGemini(env, userTitle, userPrompt) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(
      env.GEMINI_API_KEY.trim()
    )}`;

  const systemInstruction = `
You are a top-tier Indian blogger writing high-quality SEO articles in pure, natural, engaging Hindi.

Follow these rules strictly:
1. Write like an experienced human content creator—conversational, clear, engaging, and authoritative.
2. DO NOT use artificial or robotic language, repeated sentences, or cliché AI filler words.
3. Construct complete, semantic HTML markup for the post body.
4. ABSOLUTELY NO markdown formatting, NO triple backticks, NO ```html code blocks, NO external CSS, NO JavaScript, NO inline styles, and NO container divs with backgrounds.
5. Use clean standard Blogger HTML tags only: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>.
6. The content MUST include a detailed body breakdown with <h2> headings, <p> paragraphs, a dedicated FAQ section (using <h3> for questions and <p> for answers), and a clear Conclusion section.
7. Return ONLY a single raw JSON object matching the exact schema requested without any markdown wrap or extra commentary.
`;

  const promptText = `
User Context Title: ${userTitle ? userTitle.trim() : "N/A"}
User Prompt Topic: ${userPrompt.trim()}

Generate a complete, comprehensive, highly engaging Hindi post based on this request.

Output MUST be a single raw valid JSON object with the following structure:

{
  "seoTitle": "Engaging Hindi SEO Title",
  "metaDescription": "Concise SEO Meta Description in Hindi (max 150 chars)",
  "customUrl": "english-slug-for-permalink",
  "labels": ["Label1", "Label2", "Label3"],
  "contentHtml": "Full article HTML string containing paragraphs, headings, subheadings, bullet points, FAQs, and Conclusion without inline styles or markdown."
}
`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: systemInstruction },
          { text: promptText }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7
    }
  };

  const response = await fetchWithRetryAndTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    const msg = data.error?.message || response.statusText;

    throw new Error(`Gemini API Error [${response.status}]: ${msg}`);
  }

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText || !rawText.trim()) {
    throw new Error(
      "Gemini API returned an empty or invalid content candidate"
    );
  }

  try {
    const parsed = JSON.parse(cleanJsonResponse(rawText));

    // Detailed validation of generated JSON structure
    if (
      !parsed.seoTitle ||
      typeof parsed.seoTitle !== "string" ||
      !parsed.seoTitle.trim()
    ) {
      throw new Error(
        "Gemini response is missing a valid 'seoTitle'"
      );
    }

    if (
      !parsed.metaDescription ||
      typeof parsed.metaDescription !== "string" ||
      !parsed.metaDescription.trim()
    ) {
      throw new Error(
        "Gemini response is missing a valid 'metaDescription'"
      );
    }

    if (
      !parsed.contentHtml ||
      typeof parsed.contentHtml !== "string" ||
      !parsed.contentHtml.trim()
    ) {
      throw new Error(
        "Gemini response is missing valid 'contentHtml'"
      );
    }

    const cleanedHtml = cleanHtmlFormatting(parsed.contentHtml);

    validateHtmlQuality(cleanedHtml);

    // Sanitize custom permalink slug
    const customUrl = sanitizeSlug(
      parsed.customUrl || parsed.seoTitle
    );

    if (!customUrl) {
      throw new Error(
        "Failed to generate a valid permalink slug from customUrl or seoTitle"
      );
    }

    // Process and deduplicate labels
    let rawLabels = Array.isArray(parsed.labels) ? parsed.labels : [];

    let cleanLabels = [
      ...new Set(
        rawLabels
          .filter((l) => typeof l === "string" && l.trim().length > 0)
          .map((l) => l.trim())
      )
    ];

    return {
      seoTitle: parsed.seoTitle.trim(),
      metaDescription: parsed.metaDescription.trim(),
      customUrl: customUrl,
      labels: cleanLabels,
      contentHtml: cleanedHtml
    };
  } catch (e) {
    throw new Error(
      `Validation Error on Gemini response: ${e.message}`
    );
  }
}

function cleanJsonResponse(text) {
  let cleaned = text.trim();

  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }

  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }

  return cleaned.trim();
}

function cleanHtmlFormatting(html) {
  return html
    .replace(/```html/gi, "")
    .replace(/```/g, "")
    .replace(
      /<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>/gi,
      ""
    )
    .replace(
      /<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>/gi,
      ""
    )
    .replace(/style="[^"]*"/gi, "")
    .replace(/style='[^']*'/gi, "")
    .replace(/class="[^"]*"/gi, "")
    .replace(/class='[^']*'/gi, "")
    .trim();
}

function validateHtmlQuality(html) {
  if (!html || html.length < 100) {
    throw new Error(
      "Article HTML content is too short (under 100 characters)"
    );
  }

  const lowercaseHtml = html.toLowerCase();

  if (!lowercaseHtml.includes("<h2")) {
    throw new Error(
      "Article HTML is missing required '<h2>' headings"
    );
  }

  if (!lowercaseHtml.includes("<p>")) {
    throw new Error(
      "Article HTML is missing required '<p>' paragraph elements"
    );
  }

  const hasFaq =
    lowercaseHtml.includes("faq") ||
    lowercaseHtml.includes("सवाल") ||
    lowercaseHtml.includes("प्रश्नोत्तरी") ||
    lowercaseHtml.includes("प्रश्न");

  if (!hasFaq) {
    throw new Error(
      "Article HTML is missing the mandatory FAQ section"
    );
  }

  const hasConclusion =
    lowercaseHtml.includes("conclusion") ||
    lowercaseHtml.includes("निष्कर्ष") ||
    lowercaseHtml.includes("अंतिम शब्द");

  if (!hasConclusion) {
    throw new Error(
      "Article HTML is missing the mandatory Conclusion section"
    );
  }
}

function sanitizeSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9s-]/g, "")
    .trim()
    .replace(/s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function executeBloggerOperation(
  env,
  accessToken,
  article,
  mode,
  postId
) {
  const blogId = env.BLOG_ID.trim();
  const isUpdate = mode === "update";

  const endpoint = isUpdate
    ? `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(
        blogId
      )}/posts/${encodeURIComponent(postId.trim())}`
    : `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(
        blogId
      )}/posts?publish=true`;

  const method = isUpdate ? "PUT" : "POST";

  const requestBody = {
    kind: "blogger#post",
    title: article.seoTitle,
    content: article.contentHtml,
    labels: article.labels
  };

  if (article.customUrl && !isUpdate) {
    requestBody.customUrl = article.customUrl;
  }

  const response = await fetchWithRetryAndTimeout(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMessage = data.error?.message || response.statusText;

    const details = data.error?.errors
      ? JSON.stringify(data.error.errors)
      : "";

    throw new Error(
      `Blogger API Error [${response.status}]: ${errorMessage} ${details}`.trim()
    );
  }

  // Validate Blogger API response payload
  if (!data.id || typeof data.id !== "string") {
    throw new Error(
      "Blogger API returned a response missing a valid 'id'"
    );
  }

  if (!data.title || typeof data.title !== "string") {
    throw new Error(
      "Blogger API returned a response missing a valid 'title'"
    );
  }

  if (!data.url || typeof data.url !== "string") {
    throw new Error(
      "Blogger API returned a response missing a valid 'url'"
    );
  }

  return {
    title: data.title,
    url: data.url,
    postId: data.id
  };
}
