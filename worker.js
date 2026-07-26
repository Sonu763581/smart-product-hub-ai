export default {
  async fetch(request, env) {

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (request.method !== "POST") {
      return Response.json(
        {
          success: false,
          error: "Only POST requests are allowed."
        },
        {
          status: 405,
          headers: corsHeaders
        }
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          success: false,
          error: "Invalid JSON body."
        },
        {
          status: 400,
          headers: corsHeaders
        }
      );
    }
        if (!request.headers.get("Content-Type")?.includes("application/json")) {
      return Response.json(
        {
          success: false,
          error: "Content-Type must be application/json."
        },
        {
          status: 415,
          headers: corsHeaders
        }
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      typeof body.topic !== "string"
    ) {
      return Response.json(
        {
          success: false,
          error: "Missing 'topic' in request body."
        },
        {
          status: 400,
          headers: corsHeaders
        }
      );
    }

    const topic = body.topic.trim();
        if (topic.length === 0) {
      return Response.json(
        {
          success: false,
          error: "Topic cannot be empty."
        },
        {
          status: 400,
          headers: corsHeaders
        }
      );
    }
    const requiredEnv = [
  "GEMINI_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "BLOGGER_BLOG_ID"
];
    const missingEnv = requiredEnv.filter(
      (key) => !env[key]
    );

    if (missingEnv.length > 0) {
      return Response.json(
        {
          success: false,
          error: `Missing environment variables: ${missingEnv.join(", ")}`
        },
        {
          status: 500,
          headers: corsHeaders
        }
      );
    }

    try {
          const tokenResponse = await fetch(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            client_id: env.BLOGGER_CLIENT_ID,
            client_secret: env.BLOGGER_CLIENT_SECRET,
            refresh_token: env.BLOGGER_REFRESH_TOKEN,
            grant_type: "refresh_token"
          })
        }
      );

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();

        return Response.json(
          {
            success: false,
            error: "Failed to obtain Blogger access token.",
            details: errorText
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;
            const geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + env.GEMINI_API_KEY,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: topic
                  }
                ]
              }
            ]
          })
        }
      );

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();

        return Response.json(
          {
            success: false,
            error: "Gemini API request failed.",
            details: errorText
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }

      const geminiData = await geminiResponse.json();
            const generatedText =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!generatedText) {
        return Response.json(
          {
            success: false,
            error: "Gemini returned an empty response."
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }

      const bloggerResponse = await fetch(
        `https://www.googleapis.com/blogger/v3/blogs/${env.BLOG_ID}/posts/`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            title: topic,
            content: generatedText
          })
        }
      );
            if (!bloggerResponse.ok) {
        const errorText = await bloggerResponse.text();

        return Response.json(
          {
            success: false,
            error: "Failed to publish Blogger post.",
            details: errorText
          },
          {
            status: 500,
            headers: corsHeaders
          }
        );
      }

      const bloggerData = await bloggerResponse.json();

      return Response.json(
        {
          success: true,
          message: "Post published successfully.",
          postId: bloggerData.id,
          postUrl: bloggerData.url
        },
        {
          status: 200,
          headers: corsHeaders
        }
      );
          } catch (error) {
      return Response.json(
        {
          success: false,
          error: error.message || "Internal Server Error"
        },
        {
          status: 500,
          headers: corsHeaders
        }
      );
    }
  }
};

