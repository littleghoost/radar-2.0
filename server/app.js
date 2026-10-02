const express = require("express");
const path = require("path");
const crypto = require("crypto");
const db = require("./database");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(express.static(path.join(__dirname, "..", "public")));

/* =========================
   FUNÇÕES DO BANCO
========================= */

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(
      sql,
      params,

      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      },
    );
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(
      sql,
      params,

      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      },
    );
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(
      sql,
      params,

      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({
            id: this.lastID,
            changes: this.changes,
          });
        }
      },
    );
  });
}

/* =========================
   RADARES
========================= */

app.get(
  "/api/radars",

  async (_req, res) => {
    try {
      const rows = await all(`

        SELECT
          r.*,

          COUNT(l.id)
            AS listing_count,

          SUM(
            CASE
              WHEN l.status = 'interessante'
              THEN 1
              ELSE 0
            END
          )
            AS interesting_count

        FROM radars r

        LEFT JOIN listings l
          ON l.radar_id = r.id

        GROUP BY r.id

        ORDER BY r.created_at DESC

      `);

      res.json(rows);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   CRIAR RADAR
========================= */

app.post(
  "/api/radars",

  async (req, res) => {
    try {
      const { name, query, max_price, category } = req.body;

      if (!name || !query) {
        return res.status(400).json({
          error: "Nome e busca são obrigatórios.",
        });
      }

      const result = await run(
        `
        INSERT INTO radars
        (
          name,
          query,
          max_price,
          category
        )

        VALUES (?, ?, ?, ?)
        `,

        [
          name.trim(),
          query.trim(),

          max_price === "" ? null : max_price,

          category || "geral",
        ],
      );

      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [result.id],
      );

      res.status(201).json(radar);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EDITAR RADAR
========================= */

app.patch(
  "/api/radars/:id",

  async (req, res) => {
    try {
      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      const next = {
        name: req.body.name !== undefined ? req.body.name : radar.name,

        query: req.body.query !== undefined ? req.body.query : radar.query,

        max_price:
          req.body.max_price !== undefined
            ? req.body.max_price
            : radar.max_price,

        category:
          req.body.category !== undefined ? req.body.category : radar.category,
      };

      if (!next.name || !next.query) {
        return res.status(400).json({
          error: "Nome e busca são obrigatórios.",
        });
      }

      await run(
        `
        UPDATE radars

        SET
          name = ?,
          query = ?,
          max_price = ?,
          category = ?

        WHERE id = ?
        `,

        [
          next.name.trim(),
          next.query.trim(),

          next.max_price === "" ? null : next.max_price,

          next.category || "geral",

          req.params.id,
        ],
      );

      const updated = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      res.json(updated);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EXCLUIR RADAR
========================= */

app.delete(
  "/api/radars/:id",

  async (req, res) => {
    try {
      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      /*
        IMPORTANTE:

        Os anúncios NÃO são apagados.

        Eles ficam salvos,
        mas sem radar associado.
      */

      await run(
        `
        UPDATE listings
        SET radar_id = NULL
        WHERE radar_id = ?
        `,

        [req.params.id],
      );

      await run(
        "DELETE FROM radars WHERE id = ?",

        [req.params.id],
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   RODAR RADAR
========================= */

app.post(
  "/api/radars/:id/run",

  async (req, res) => {
    try {
      const radar = await get(
        "SELECT * FROM radars WHERE id = ?",

        [req.params.id],
      );

      if (!radar) {
        return res.status(404).json({
          error: "Radar não encontrado.",
        });
      }

      /*
        Aqui entraremos depois com:

        Mercado Livre
        OLX
        Enjoei
        eBay
        Mercari
        etc.
      */

      res.json({
        ok: true,

        radar,

        message:
          "Radar preparado. Ainda precisamos conectar uma fonte automática.",
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   LISTAR ANÚNCIOS
========================= */

app.get(
  "/api/listings",

  async (req, res) => {
    try {
      const { radar_id, status, search } = req.query;

      const filters = [];

      const params = [];

      if (radar_id) {
        filters.push("l.radar_id = ?");

        params.push(radar_id);
      }

      if (status && status !== "todos") {
        filters.push("l.status = ?");

        params.push(status);
      }

      if (search) {
        filters.push(`
          (
            l.title LIKE ?
            OR l.platform LIKE ?
            OR l.notes LIKE ?
          )
        `);

        const q = `%${search}%`;

        params.push(q, q, q);
      }

      const where = filters.length
        ? `
            WHERE
            ${filters.join(" AND ")}
          `
        : "";

      const rows = await all(
        `

        SELECT

          l.*,

          r.name
            AS radar_name,

          (

            SELECT
              ph.price

            FROM price_history ph

            WHERE
              ph.listing_id = l.id

            ORDER BY
              ph.captured_at ASC

            LIMIT 1

          )
            AS first_price

        FROM listings l

        LEFT JOIN radars r

          ON r.id = l.radar_id

        ${where}

        ORDER BY

          CASE l.status

            WHEN 'interessante'
              THEN 1

            WHEN 'novo'
              THEN 2

            WHEN 'descartado'
              THEN 3

            WHEN 'vendido'
              THEN 4

            ELSE 5

          END,

          l.updated_at DESC

        `,

        params,
      );

      res.json(rows);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   CRIAR ANÚNCIO
========================= */

app.post(
  "/api/listings",

  async (req, res) => {
    try {
      const {
        radar_id,
        title,
        platform,
        url,
        image_url,
        current_price,
        status,
        notes,
      } = req.body;

      if (!title || !platform || !url) {
        return res.status(400).json({
          error: "Título, plataforma e URL são obrigatórios.",
        });
      }

      const existing = await get(
        `
          SELECT *
          FROM listings
          WHERE url = ?
          `,

        [url.trim()],
      );

      if (existing) {
        return res.status(409).json({
          error: "Esse anúncio já está salvo.",

          listing: existing,
        });
      }

      const result = await run(
        `

          INSERT INTO listings
          (
            radar_id,
            title,
            platform,
            url,
            image_url,
            current_price,
            status,
            notes
          )

          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?
          )

          `,

        [
          radar_id || null,

          title.trim(),

          platform.trim(),

          url.trim(),

          image_url?.trim() || null,

          current_price === "" ? null : current_price,

          status || "novo",

          notes?.trim() || null,
        ],
      );

      if (
        current_price !== undefined &&
        current_price !== null &&
        current_price !== ""
      ) {
        await run(
          `
          INSERT INTO price_history
          (
            listing_id,
            price
          )

          VALUES (?, ?)
          `,

          [result.id, current_price],
        );
      }

      const listing = await get(
        `
          SELECT *
          FROM listings
          WHERE id = ?
          `,

        [result.id],
      );

      res.status(201).json(listing);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EDITAR ANÚNCIO
========================= */

app.patch(
  "/api/listings/:id",

  async (req, res) => {
    try {
      const listing = await get(
        `
          SELECT *
          FROM listings
          WHERE id = ?
          `,

        [req.params.id],
      );

      if (!listing) {
        return res.status(404).json({
          error: "Anúncio não encontrado.",
        });
      }

      const next = {
        radar_id:
          req.body.radar_id !== undefined
            ? req.body.radar_id
            : listing.radar_id,

        title: req.body.title !== undefined ? req.body.title : listing.title,

        platform:
          req.body.platform !== undefined
            ? req.body.platform
            : listing.platform,

        url: req.body.url !== undefined ? req.body.url : listing.url,

        image_url:
          req.body.image_url !== undefined
            ? req.body.image_url
            : listing.image_url,

        current_price:
          req.body.current_price !== undefined
            ? req.body.current_price
            : listing.current_price,

        status:
          req.body.status !== undefined ? req.body.status : listing.status,

        notes: req.body.notes !== undefined ? req.body.notes : listing.notes,
      };

      const priceChanged =
        req.body.current_price !== undefined &&
        Number(req.body.current_price) !== Number(listing.current_price);

      await run(
        `

        UPDATE listings

        SET
          radar_id = ?,
          title = ?,
          platform = ?,
          url = ?,
          image_url = ?,
          current_price = ?,
          status = ?,
          notes = ?,
          updated_at = CURRENT_TIMESTAMP

        WHERE id = ?

        `,

        [
          next.radar_id || null,

          next.title,

          next.platform,

          next.url,

          next.image_url || null,

          next.current_price === "" ? null : next.current_price,

          next.status,

          next.notes || null,

          req.params.id,
        ],
      );

      if (
        priceChanged &&
        req.body.current_price !== "" &&
        req.body.current_price !== null
      ) {
        await run(
          `
          INSERT INTO price_history
          (
            listing_id,
            price
          )

          VALUES (?, ?)
          `,

          [req.params.id, req.body.current_price],
        );
      }

      const updated = await get(
        `
          SELECT *
          FROM listings
          WHERE id = ?
          `,

        [req.params.id],
      );

      res.json(updated);
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) {
        return res.status(409).json({
          error: "Já existe um anúncio com essa URL.",
        });
      }

      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   EXCLUIR ANÚNCIO
========================= */

app.delete(
  "/api/listings/:id",

  async (req, res) => {
    try {
      await run(
        `
        DELETE FROM price_history
        WHERE listing_id = ?
        `,

        [req.params.id],
      );

      await run(
        `
        DELETE FROM listings
        WHERE id = ?
        `,

        [req.params.id],
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   HISTÓRICO DE PREÇO
========================= */

app.get(
  "/api/listings/:id/prices",

  async (req, res) => {
    try {
      const prices = await all(
        `

          SELECT *
          FROM price_history

          WHERE listing_id = ?

          ORDER BY
            captured_at ASC

          `,

        [req.params.id],
      );

      res.json(prices);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);
/* =========================
   OAUTH MERCADO LIVRE
========================= */

function getMlConfig() {
  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  const redirectUri = process.env.ML_REDIRECT_URI;
  const stateSecret = process.env.OAUTH_STATE_SECRET;

  if (!clientId || !clientSecret || !redirectUri || !stateSecret) {
    throw new Error("OAuth do Mercado Livre ainda não está configurado no servidor.");
  }

  return { clientId, clientSecret, redirectUri, stateSecret };
}

function createOAuthState(secret) {
  const payload = `${Date.now()}.${crypto.randomBytes(24).toString("hex")}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function validateOAuthState(state, secret) {
  if (!state) return false;
  const parts = String(state).split(".");
  if (parts.length !== 3) return false;

  const [timestamp, nonce, signature] = parts;
  const payload = `${timestamp}.${nonce}`;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");

  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  const age = Date.now() - Number(timestamp);
  return Number.isFinite(age) && age >= 0 && age <= 10 * 60 * 1000;
}

app.get("/auth/mercadolivre", (_req, res) => {
  try {
    const { clientId, redirectUri, stateSecret } = getMlConfig();
    const state = createOAuthState(stateSecret);
    const url = new URL("https://auth.mercadolivre.com.br/authorization");

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    res.redirect(url.toString());
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/auth/mercadolivre/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const { clientId, clientSecret, redirectUri, stateSecret } = getMlConfig();

    if (!code || !validateOAuthState(state, stateSecret)) {
      return res.status(400).send("Resposta OAuth inválida ou expirada.");
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody,
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.message || tokenData.error || "Falha ao obter token do Mercado Livre.");
    }

    const profileResponse = await fetch("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileResponse.json();

    if (!profileResponse.ok) {
      throw new Error(profile.message || "Falha ao carregar perfil do Mercado Livre.");
    }

    const user = await get("SELECT * FROM users LIMIT 1");
    if (!user) throw new Error("Usuário local não encontrado.");

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null;

    await run(
      `INSERT INTO connections (
        user_id, provider, provider_user_id, provider_username,
        access_token, refresh_token, expires_at, status, updated_at
      ) VALUES (?, 'mercadolivre', ?, ?, ?, ?, ?, 'connected', CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        provider_user_id = excluded.provider_user_id,
        provider_username = excluded.provider_username,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        status = 'connected',
        updated_at = CURRENT_TIMESTAMP`,
      [
        user.id,
        String(tokenData.user_id || profile.id || ""),
        profile.nickname || profile.email || null,
        tokenData.access_token,
        tokenData.refresh_token || null,
        expiresAt,
      ],
    );

    res.redirect("/?connected=mercadolivre");
  } catch (err) {
    console.error("Erro OAuth Mercado Livre:", err);
    res.status(500).send(`Erro ao conectar Mercado Livre: ${err.message}`);
  }
});

/* =========================
   CONEXÕES
========================= */

app.get(
  "/api/connections",

  async (_req, res) => {
    try {
      const user = await get("SELECT * FROM users LIMIT 1");

      if (!user) {
        return res.json([]);
      }

      const connections = await all(
        `
          SELECT
            id,
            provider,
            provider_username,
            status,
            expires_at,
            updated_at

          FROM connections

          WHERE user_id = ?
          `,
        [user.id],
      );

      const providers = ["olx", "mercadolivre", "ebay"];

      const result = providers.map((provider) => {
        const existing = connections.find((item) => item.provider === provider);

        return (
          existing || {
            provider,

            status: "disconnected",

            provider_username: null,

            expires_at: null,
          }
        );
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   DESCONECTAR
========================= */

app.delete(
  "/api/connections/:provider",

  async (req, res) => {
    try {
      const user = await get("SELECT * FROM users LIMIT 1");

      if (!user) {
        return res.status(404).json({
          error: "Usuário não encontrado.",
        });
      }

      await run(
        `
        DELETE FROM connections

        WHERE
          user_id = ?
          AND provider = ?
        `,
        [user.id, req.params.provider],
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  },
);

/* =========================
   SITE
========================= */

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

/* =========================
   INICIAR SERVIDOR
========================= */

app.listen(
  PORT,

  () => {
    console.log(`Radar 2.0 rodando em http://localhost:${PORT}`);
  },
);
