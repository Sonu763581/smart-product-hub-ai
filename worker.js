/**
 * Production-Ready Cloudflare Worker: Gemini to Blogger Publisher
 * 
 * Securely handles CORS preflight, exchanges Google OAuth2 refresh tokens,
 * forces Gemini 1.5 Flash to output structured JSON with HTML bodies, 
 * and publishes directly to the Google Blogger API.
 */

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight and Header Operations
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // Only allow POST requests for execution
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed. Use POST." }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    try {
      // 2. Validate Infrastructure Environment Configurations
      validateEnvironment(env);

      // 3. Extract and Process Payload
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON format in request body." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const { topic } = payload;
      if (!topic || typeof topic !== "string" || topic.trim() === "") {
        return new Response(JSON.stringify({ error: "Missing required string parameter: 'topic'" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // 4. Generate Semantic HTML Article using Gemini API
      const article = await generateGeminiArticle(topic.trim(), env.GEMINI_API_KEY);

      // 5. Rotate Google OAuth Credentials to get Access Token
      const accessToken = await getGoogleAccessToken(
        env.GOOGLE_CLIENT_ID, 
        env.GOOGLE_CLIENT_SECRET, 
        env.GOOGLE_REFRESH_TOKEN
      );

      // 6. Transmit Document Payload to Google Blogger Service
      const bloggerData = await publishToBlogger(
        env.BLOGGER_BLOG_ID, 
        accessToken, 
        article.title, 
        article.content
      );

      // 7. Standard Success Transmission
      return new Response(JSON.stringify({
        success: true,
        message: "Article processed and published successfully.",
        postId: bloggerData.id,
        url: bloggerData.url,
        title: article.title
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (error) {
      // Systemic Exception Containment and Auditing
      console.error("Critical Worker Exception:", error.message);
      return new Response(JSON.stringify({ 
        success: false, 
        error: error.message || "Internal Server Error during pipeline execution." 
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }
};

/**
 * Validates existence of critical production credentials within core bindings.
 */
function validateEnvironment(env) {
  const requirements = [
    "GEMINI_API_KEY", 
    "GOOGLE_CLIENT_ID", 
    "GOOGLE_CLIENT_SECRET", 
    "GOOGLE_REFRESH_TOKEN", 
    "BLOGGER_BLOG_ID"
  ];
  for (const requirement of requirements) {
    if (!env[requirement] || env[requirement].trim() === "") {
      throw new Error(`Runtime configuration error: Missing required binding [${requirement}]`);
    }
  }
}

/**
 * Commands the Gemini Engine to construct clean semantic structural HTML inside JSON.
 */
async function generateGeminiArticle(topic, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const instruction = `Write an extensive, professional, SEO-optimized blog article focused on "${topic}". 
  You must output your complete response in raw JSON format exactly following this layout schema structure:
  {
    "title": "An engaging, keyword-rich title for the blog post",
    "content": "Provide the extensive blog body here wrapped purely inside valid semantic HTML strings using elements like <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>. Do NOT include generic markdown formatting code blocks like \\\`\\\`\\\`html, do NOT wrap with outer structural tags like <html>, <head>, or <body>. Provide only structural semantic body markup."
  }`;

  const requestOptions = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: instruction }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.7
      }
    })
  };

  const response = await fetch(endpoint, requestOptions);
  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`Gemini Interface Generation failure (Status ${response.status}): ${errorDetails}`);
  }

  const payloadData = await response.json();
  
  if (!payloadData.candidates || !payloadData.candidates[0] || !payloadData.candidates[0].content || !payloadData.candidates[0].content.parts || !payloadData.candidates[0].content.parts[0] || !payloadData.candidates[0].content.parts[0].text) {
    throw new Error("Malformed payload hierarchy received from Gemini upstream endpoint.");
  }

  const rawJsonOutput = payloadData.candidates[0].content.parts[0].text;
  
  try {
    return JSON.parse(rawJsonOutput.trim());
  } catch (jsonParseError) {
    throw new Error(`JSON deserialization exception on generated model schema. Raw output stream: ${rawJsonOutput}`);
  }
}

/**
 * Automates token rotation against the authorization server using a persistent refresh token.
 */
async function getGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const oauthTokenUrl = "https://oauth2.googleapis.com/token";
  
  const transformationPayload = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch(oauthTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: transformationPayload.toString()
  });

  if (!response.ok) {
    const errorFeedback = await response.text();
    throw new Error(`Google Access Token exchange pipeline failures (Status ${response.status}): ${errorFeedback}`);
  }

  const credentialSet = await response.json();
  if (!credentialSet.access_token) {
    throw new Error("Token server responded successfully but omitted expected access_token key.");
  }
  
  return credentialSet.access_token;
}

/**
 * Transmits structural document payload directly to the validated Google Blogger engine.
 */
async function publishToBlogger(blogId, accessToken, title, content) {
  const bloggerEndpoint = `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts?isDraft=false`;
  const dynamicPostPayload = {
    kind: "blogger#post",
    title: title,
    content: content
  };

  const response = await fetch(bloggerEndpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(dynamicPostPayload)
  });

  if (!response.ok) {
    const apiErrorFeedback = await response.text();
    throw new Error(`Google Blogger Resource Server rejection (Status ${response.status}): ${apiErrorFeedback}`);
  }

  return await response.json();
}
