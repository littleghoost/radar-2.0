const fs = require('fs/promises');
const { searchAllSources, checkListingAvailability } = require('./sources');
const { downloadImage, extractVisualFeatures, visualSimilarity, hybridScore } = require('./visualSimilarity');
const { embedImage, cosineSimilarity: semanticSimilarity } = require('./semanticVision');
const { buildPreferenceProfile, preferenceScore, grailScore } = require('./preferenceLearning');
const {
  evaluateRadarCriteria,
  blendCriteriaScore,
} = require('./radarCriteria');


async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function isForeignMarketplaceItem(item = {}) {
  const itemCountry = String(
    item.item_country || "",
  ).toUpperCase();

  if (itemCountry) {
    return itemCountry !== "BR";
  }

  return item.source === "ebay";
}

function createRadarRunner({
  get,
  all,
  run,
  getValidMercadoLivreConnection,
  getInternationalCostSettings,
}) {
  async function verifyKnownListings({
    radar,
    runId,
    mercadoLivreAccessToken,
    ebayCredentials,
    seenKeys,
  }) {
    const candidates = await all(
      `SELECT *
       FROM listings
       WHERE radar_id = ?
         AND source_key IN ('mercadolivre', 'ebay')
         AND external_id IS NOT NULL
       ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC
       LIMIT 30`,
      [radar.id],
    );

    let checked = 0;
    let unavailable = 0;
    let restored = 0;
    let priceDrops = 0;

    await mapWithConcurrency(candidates, 3, async (listing) => {
      const key = `${listing.source_key}:${listing.external_id}`;

      if (seenKeys.has(key)) {
        if (listing.availability_status === 'unavailable') {
          await run(
            `INSERT INTO activity_events
              (radar_id, run_id, listing_id, type, title, detail, metadata_json)
             VALUES (?, ?, ?, 'listing_available', ?, ?, ?)`,
            [
              radar.id,
              runId,
              listing.id,
              `Anúncio voltou: ${listing.title}`,
              `${listing.platform} voltou a aparecer na busca.`,
              JSON.stringify({
                url: listing.url,
                platform: listing.platform,
                source: listing.source_key,
                external_id: listing.external_id,
              }),
            ],
          );
          restored += 1;
        }

        await run(
          `UPDATE listings
           SET availability_status = 'available',
               availability_detail = 'found_in_search',
               last_seen_at = CURRENT_TIMESTAMP,
               last_checked_at = CURRENT_TIMESTAMP,
               unavailable_since = NULL
           WHERE id = ?`,
          [listing.id],
        );

        checked += 1;
        return;
      }

      const verification = await checkListingAvailability({
        sourceKey: listing.source_key,
        externalId: listing.external_id,
        mercadoLivreAccessToken,
        ebayCredentials,
      });

      if (!verification?.verifiable || !verification.ok) {
        return;
      }

      checked += 1;

      const nextAvailability = verification.available
        ? 'available'
        : 'unavailable';
      const previousAvailability = listing.availability_status || 'unknown';

      let nextPrice =
        verification.price === null || verification.price === undefined
          ? null
          : Number(verification.price);

      if (!Number.isFinite(nextPrice)) {
        nextPrice = null;
      }

      const previousPrice =
        listing.current_price === null || listing.current_price === undefined
          ? null
          : Number(listing.current_price);

      const verifiedCurrency =
        verification.currency || listing.currency || 'BRL';
      const priceChanged =
        nextPrice !== null &&
        previousPrice !== null &&
        nextPrice !== previousPrice;
      const priceDropped =
        priceChanged &&
        nextPrice < previousPrice &&
        verifiedCurrency === (listing.currency || 'BRL');

      await run(
        `UPDATE listings
         SET availability_status = ?,
             availability_detail = ?,
             last_checked_at = CURRENT_TIMESTAMP,
             unavailable_since = CASE
               WHEN ? = 'unavailable'
                 THEN COALESCE(unavailable_since, CURRENT_TIMESTAMP)
               ELSE NULL
             END,
             current_price = COALESCE(?, current_price),
             currency = COALESCE(?, currency),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          nextAvailability,
          verification.detail || null,
          nextAvailability,
          nextPrice,
          verification.currency || null,
          listing.id,
        ],
      );

      if (priceChanged) {
        await run(
          'INSERT INTO price_history (listing_id, price) VALUES (?, ?)',
          [listing.id, nextPrice],
        );
      }

      if (priceDropped) {
        await run(
          `INSERT INTO activity_events
            (radar_id, run_id, listing_id, type, title, detail, metadata_json)
           VALUES (?, ?, ?, 'price_drop', ?, ?, ?)`,
          [
            radar.id,
            runId,
            listing.id,
            `Preço caiu: ${listing.title}`,
            `${verifiedCurrency} ${previousPrice} → ${verifiedCurrency} ${nextPrice}`,
            JSON.stringify({
              url: listing.url,
              platform: listing.platform,
              previous_price: previousPrice,
              current_price: nextPrice,
              currency: verifiedCurrency,
              source: listing.source_key,
              verified_directly: true,
            }),
          ],
        );
        priceDrops += 1;
      }

      if (
        nextAvailability === 'unavailable' &&
        previousAvailability !== 'unavailable'
      ) {
        await run(
          `INSERT INTO activity_events
            (radar_id, run_id, listing_id, type, title, detail, metadata_json)
           VALUES (?, ?, ?, 'listing_unavailable', ?, ?, ?)`,
          [
            radar.id,
            runId,
            listing.id,
            `Anúncio indisponível: ${listing.title}`,
            `${listing.platform} • ${verification.detail || 'item indisponível'}`,
            JSON.stringify({
              url: listing.url,
              platform: listing.platform,
              source: listing.source_key,
              external_id: listing.external_id,
              verification,
            }),
          ],
        );
        unavailable += 1;
      }

      if (
        nextAvailability === 'available' &&
        previousAvailability === 'unavailable'
      ) {
        await run(
          `INSERT INTO activity_events
            (radar_id, run_id, listing_id, type, title, detail, metadata_json)
           VALUES (?, ?, ?, 'listing_available', ?, ?, ?)`,
          [
            radar.id,
            runId,
            listing.id,
            `Anúncio voltou: ${listing.title}`,
            `${listing.platform} voltou a ficar disponível.`,
            JSON.stringify({
              url: listing.url,
              platform: listing.platform,
              source: listing.source_key,
              external_id: listing.external_id,
            }),
          ],
        );
        restored += 1;
      }
    });

    return {
      checked,
      unavailable,
      restored,
      price_drops: priceDrops,
    };
  }

  async function executeRadarById(radarId, options = {}) {
    let runRecord = null;
    const trigger = options.trigger || 'manual';

    try {
      const radar = await get('SELECT * FROM radars WHERE id = ?', [radarId]);
      if (!radar) {
        const error = new Error('Radar não encontrado.');
        error.status = 404;
        throw error;
      }

      const started = await run(
        `INSERT INTO radar_runs (radar_id, status, trigger_type)
         VALUES (?, 'running', ?)`,
        [radar.id, trigger],
      );
      runRecord = { id: started.id, radar_id: radar.id };

      const user = await get('SELECT * FROM users LIMIT 1');
      if (!user) throw new Error('Usuário local não encontrado.');

      const mlConnection = await getValidMercadoLivreConnection(user.id);
      const ebayConnection = await get(
        `SELECT developer_client_id, developer_client_secret, marketplace_id, status
         FROM connections
         WHERE user_id = ? AND provider = 'ebay'
         LIMIT 1`,
        [user.id],
      );

      const ebayCredentials =
        ebayConnection?.status === "connected" &&
        ebayConnection.developer_client_id &&
        ebayConnection.developer_client_secret
          ? {
              clientId: ebayConnection.developer_client_id,
              clientSecret: ebayConnection.developer_client_secret,
              marketplaceId:
                ebayConnection.marketplace_id || "EBAY_US",
            }
          : null;

      const internationalSettings =
        typeof getInternationalCostSettings === "function"
          ? await getInternationalCostSettings().catch(() => null)
          : null;

      const ebayDestination =
        internationalSettings?.destination_country
          ? {
              country:
                internationalSettings.destination_country,
              postalCode:
                internationalSettings.destination_postal_code || "",
            }
          : null;

      let referenceImageBuffer = null;
      if (radar.reference_image_path) {
        try {
          referenceImageBuffer = await fs.readFile(radar.reference_image_path);
        } catch {
          referenceImageBuffer = null;
        }
      }
      const sourceRuns = await searchAllSources({
        query: radar.query,
        referenceImageBuffer,
        mercadoLivreAccessToken:
          mlConnection?.status === 'connected' ? mlConnection.access_token : null,
        ebayCredentials,
        ebayDestination,
        limit: 50,
      });

      const maxPrice = radar.max_price === null ? null : Number(radar.max_price);
      const successfulItems = sourceRuns.flatMap((source) =>
        source.ok ? source.items : [],
      );

      const catalogItems = sourceRuns.flatMap((source) =>
        Array.isArray(source.catalog_items)
          ? source.catalog_items
          : [],
      );

      let catalogAdded = 0;
      let catalogUpdated = 0;

      for (const product of catalogItems) {
        if (!product.external_id || !product.title) continue;

        const catalogDomain = String(product.domain_id || "").toUpperCase();
        const catalogTitle = String(product.title || "").toLowerCase();
        const accessoryCatalog =
          /BATTER|CHARGER|CABLE|ADAPTER|ACCESSOR/.test(catalogDomain) ||
          /\b(bateria|carregador|cabo|adaptador|fonte)\b/i.test(catalogTitle);

        if (
          radar.category === "cameras" &&
          accessoryCatalog
        ) {
          continue;
        }

        const existingCatalog = await get(
          `SELECT id
           FROM catalog_discoveries
           WHERE radar_id = ?
             AND source_key = ?
             AND external_id = ?`,
          [
            radar.id,
            product.source || "mercadolivre_catalog",
            product.external_id,
          ],
        );

        if (existingCatalog) {
          await run(
            `UPDATE catalog_discoveries
             SET title = ?,
                 url = ?,
                 image_url = ?,
                 product_status = ?,
                 domain_id = ?,
                 metadata_json = ?,
                 last_seen_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              product.title,
              product.url || null,
              product.image_url || null,
              product.product_status || null,
              product.domain_id || null,
              JSON.stringify({
                search_query: product.search_query || null,
                ...(product.metadata || {}),
              }),
              existingCatalog.id,
            ],
          );

          catalogUpdated += 1;
          continue;
        }

        const insertedCatalog = await run(
          `INSERT INTO catalog_discoveries (
            radar_id, source_key, external_id, title, url,
            image_url, product_status, domain_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            radar.id,
            product.source || "mercadolivre_catalog",
            product.external_id,
            product.title,
            product.url || null,
            product.image_url || null,
            product.product_status || null,
            product.domain_id || null,
            JSON.stringify({
              search_query: product.search_query || null,
              ...(product.metadata || {}),
            }),
          ],
        );

        await run(
          `INSERT INTO activity_events
            (radar_id, run_id, type, title, detail, metadata_json)
           VALUES (?, ?, 'catalog_discovery', ?, ?, ?)`,
          [
            radar.id,
            runRecord.id,
            `Pista de catálogo: ${product.title}`,
            product.domain_id
              ? `Mercado Livre Catálogo • ${product.domain_id}`
              : "Mercado Livre Catálogo",
            JSON.stringify({
              catalog_discovery_id: insertedCatalog.id,
              external_id: product.external_id,
              url: product.url || null,
              search_query: product.search_query || null,
            }),
          ],
        );

        catalogAdded += 1;
      }

      const seenKeys = new Set(
        successfulItems
          .filter((item) => item.source && item.external_id)
          .map((item) => `${item.source}:${item.external_id}`),
      );

      let results = successfulItems
        .filter((item) => {
          if (!item.url || !item.title) return false;
          if (maxPrice === null || Number.isNaN(maxPrice)) return true;
          if (isForeignMarketplaceItem(item)) return true;
          if (item.currency && item.currency !== 'BRL') return true;
          return item.price === null || Number(item.price) <= maxPrice;
        })
        .slice(0, 60);

      const visualEnabled = Boolean(radar.visual_enabled && radar.reference_features_json);
      const referenceFeatures = visualEnabled
        ? JSON.parse(radar.reference_features_json)
        : null;
      const minVisualSimilarity = Number(radar.min_visual_similarity ?? 0.45);
      const visualWeight = Number(radar.visual_weight ?? 70);
      const semanticEnabled = Boolean(radar.semantic_enabled && radar.reference_embedding_json);
      const referenceEmbedding = semanticEnabled
        ? JSON.parse(radar.reference_embedding_json)
        : null;
      const semanticWeight = Number(radar.semantic_weight ?? 70);
      const feedbackRows = await all(
        `SELECT l.status, l.image_embedding_json
         FROM listings l
         LEFT JOIN radars r ON r.id = l.radar_id
         WHERE COALESCE(r.category, 'geral') = ?
           AND l.status IN ('interessante', 'descartado')
           AND l.image_embedding_json IS NOT NULL`,
        [radar.category || 'geral'],
      );
      const preferenceProfile = buildPreferenceProfile(feedbackRows, radar.category || 'geral');

      results = await mapWithConcurrency(results, semanticEnabled ? 2 : 4, async (item) => {
        let candidateFeatures = null;
        let candidateEmbedding = null;
        let visualScore = null;
        let semanticScore = null;
        let imageBuffer = null;

        if ((visualEnabled || semanticEnabled) && item.image_url) {
          try {
            imageBuffer = await downloadImage(item.image_url);
          } catch {
            imageBuffer = null;
          }
        }

        if (visualEnabled) {
          if (imageBuffer) {
            try {
              candidateFeatures = await extractVisualFeatures(imageBuffer);
              visualScore = visualSimilarity(referenceFeatures, candidateFeatures);
            } catch {
              visualScore = 0;
            }
          } else {
            visualScore = 0;
          }
        }

        if (semanticEnabled) {
          if (imageBuffer) {
            try {
              candidateEmbedding = await embedImage(imageBuffer);
              semanticScore = semanticSimilarity(referenceEmbedding, candidateEmbedding);
            } catch {
              semanticScore = 0;
            }
          } else {
            semanticScore = 0;
          }
        }

        const foreignItem =
          isForeignMarketplaceItem(item);

        const combinedScore = hybridScore({
          visual: visualEnabled ? visualScore : null,
          semantic: semanticEnabled ? semanticScore : null,
          query: radar.query,
          title: item.title,
          price: item.price,
          maxPrice: foreignItem ? null : maxPrice,
          currency: item.currency || 'BRL',
          visualWeight,
          semanticWeight,
        });

        const learnedScore = preferenceScore(candidateEmbedding, preferenceProfile);
        const finalGrailScore = grailScore(
          combinedScore,
          learnedScore,
          preferenceProfile.total_feedback,
        );
        const criteria = evaluateRadarCriteria(
          radar,
          {
            title: item.title,
            platform: item.platform,
            price: item.price,
            currency: item.currency || 'BRL',
            condition: item.condition,
            source_key: item.source || null,
            item_country: item.item_country || null,
          },
        );
        const rankingScore = blendCriteriaScore(
          finalGrailScore,
          criteria,
          radar,
        );

        return {
          ...item,
          visual_score: visualScore === null ? null : Math.round(visualScore * 100),
          semantic_score: semanticScore === null ? null : Math.round(semanticScore * 100),
          hybrid_score: combinedScore,
          preference_score: learnedScore,
          grail_score: finalGrailScore,
          ranking_score: rankingScore,
          rule_score: criteria.score,
          rule_tier: criteria.tier,
          rule_rejected: criteria.rejected ? 1 : 0,
          rule_reason_json: JSON.stringify(criteria.reasons),
          image_features_json: candidateFeatures ? JSON.stringify(candidateFeatures) : null,
          image_embedding_json: candidateEmbedding ? JSON.stringify(candidateEmbedding) : null,
        };
      });

      const criteriaRejected = results.filter(
        (item) => Boolean(item.rule_rejected),
      ).length;

      results = results.filter(
        (item) => !item.rule_rejected,
      );

      if (visualEnabled || semanticEnabled) {
        results = results
          .filter((item) => Math.max(Number(item.visual_score) || 0, Number(item.semantic_score) || 0) >= minVisualSimilarity * 100)
          .sort((a, b) => Number(b.ranking_score ?? b.grail_score ?? b.hybrid_score ?? 0) - Number(a.ranking_score ?? a.grail_score ?? a.hybrid_score ?? 0));
      } else {
        results.sort((a, b) => Number(b.ranking_score ?? b.grail_score ?? b.hybrid_score ?? 0) - Number(a.ranking_score ?? a.grail_score ?? a.hybrid_score ?? 0));
      }

      let added = 0;
      let updated = 0;
      let priceDrops = 0;
      let availabilityChecks = 0;
      let unavailable = 0;
      let restored = 0;

      for (const item of results) {
        let existing = null;

        if (item.source && item.external_id) {
          existing = await get(
            `SELECT * FROM listings
             WHERE source_key = ? AND external_id = ?
             LIMIT 1`,
            [item.source, item.external_id],
          );
        }

        if (!existing && item.url) {
          existing = await get(
            'SELECT * FROM listings WHERE url = ? LIMIT 1',
            [item.url],
          );
        }

        const nextPrice = item.price === null ? null : Number(item.price);
        const currency = item.currency || 'BRL';
        const sourceNote = item.external_id
          ? `ID ${item.platform}: ${item.external_id}`
          : null;

        if (!existing) {
          const insert = await run(
            `INSERT INTO listings
              (radar_id, title, platform, url, image_url, current_price, currency,
               shipping_price, shipping_currency, shipping_type, item_country, status, notes,
               source_key, external_id, availability_status, availability_detail, last_seen_at, last_checked_at,
               visual_score, semantic_score, hybrid_score, preference_score, grail_score,
               rule_score, rule_tier, rule_rejected, rule_reason_json,
               image_features_json, image_embedding_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo', ?, ?, ?, 'available', 'found_in_search',
                     CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              radar.id,
              item.title,
              item.platform,
              item.url,
              item.image_url,
              nextPrice,
              currency,
              item.shipping_price ?? null,
              item.shipping_currency || null,
              item.shipping_type || null,
              item.item_country || null,
              sourceNote,
              item.source || null,
              item.external_id || null,
              item.visual_score,
              item.semantic_score,
              item.hybrid_score,
              item.preference_score,
              item.grail_score,
              item.rule_score,
              item.rule_tier,
              item.rule_rejected,
              item.rule_reason_json,
              item.image_features_json,
              item.image_embedding_json,
            ],
          );

          if (nextPrice !== null && !Number.isNaN(nextPrice)) {
            await run(
              'INSERT INTO price_history (listing_id, price) VALUES (?, ?)',
              [insert.id, nextPrice],
            );
          }

          await run(
            `INSERT INTO activity_events
              (radar_id, run_id, listing_id, type, title, detail, metadata_json)
             VALUES (?, ?, ?, 'new_listing', ?, ?, ?)`,
            [
              radar.id,
              runRecord.id,
              insert.id,
              `Novo anúncio: ${item.title}`,
              `${item.platform}${nextPrice === null ? '' : ` • ${currency} ${nextPrice}`}`,
              JSON.stringify({ url: item.url, platform: item.platform, visual_score: item.visual_score, semantic_score: item.semantic_score, hybrid_score: item.hybrid_score, preference_score: item.preference_score, grail_score: item.grail_score }),
            ],
          );
          added += 1;
          continue;
        }

        const previousPrice =
          existing.current_price === null ? null : Number(existing.current_price);
        const priceChanged =
          nextPrice !== null && previousPrice !== null && previousPrice !== nextPrice;
        const priceDropped =
          priceChanged &&
          nextPrice < previousPrice &&
          (existing.currency || 'BRL') === currency;

        await run(
          `UPDATE listings
           SET radar_id = ?, title = ?, platform = ?,
               url = COALESCE(?, url), image_url = ?,
               current_price = ?, currency = ?,
               shipping_price = ?, shipping_currency = ?, shipping_type = ?,
               item_country = COALESCE(?, item_country),
               source_key = COALESCE(?, source_key),
               external_id = COALESCE(?, external_id),
               availability_status = 'available', availability_detail = 'found_in_search',
               last_seen_at = CURRENT_TIMESTAMP, last_checked_at = CURRENT_TIMESTAMP,
               unavailable_since = NULL,
               visual_score = ?, semantic_score = ?, hybrid_score = ?,
               preference_score = ?, grail_score = ?,
               rule_score = ?, rule_tier = ?, rule_rejected = ?, rule_reason_json = ?,
               image_features_json = COALESCE(?, image_features_json),
               image_embedding_json = COALESCE(?, image_embedding_json), updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            radar.id,
            item.title,
            item.platform,
            item.url || null,
            item.image_url,
            nextPrice,
            currency,
            item.shipping_price ?? null,
            item.shipping_currency || null,
            item.shipping_type || null,
            item.item_country || null,
            item.source || null,
            item.external_id || null,
            item.visual_score,
            item.semantic_score,
            item.hybrid_score,
            item.preference_score,
            item.grail_score,
            item.rule_score,
            item.rule_tier,
            item.rule_rejected,
            item.rule_reason_json,
            item.image_features_json,
            item.image_embedding_json,
            existing.id,
          ],
        );

        if (existing.availability_status === 'unavailable') {
          await run(
            `INSERT INTO activity_events
              (radar_id, run_id, listing_id, type, title, detail, metadata_json)
             VALUES (?, ?, ?, 'listing_available', ?, ?, ?)`,
            [
              radar.id,
              runRecord.id,
              existing.id,
              `Anúncio voltou: ${item.title}`,
              `${item.platform} voltou a ficar disponível.`,
              JSON.stringify({
                url: item.url,
                platform: item.platform,
                source: item.source || existing.source_key || null,
              }),
            ],
          );
        }

        if (priceChanged) {
          await run(
            'INSERT INTO price_history (listing_id, price) VALUES (?, ?)',
            [existing.id, nextPrice],
          );
        }

        if (priceDropped) {
          await run(
            `INSERT INTO activity_events
              (radar_id, run_id, listing_id, type, title, detail, metadata_json)
             VALUES (?, ?, ?, 'price_drop', ?, ?, ?)`,
            [
              radar.id,
              runRecord.id,
              existing.id,
              `Preço caiu: ${item.title}`,
              `${currency} ${previousPrice} → ${currency} ${nextPrice}`,
              JSON.stringify({
                url: item.url,
                platform: item.platform,
                previous_price: previousPrice,
                current_price: nextPrice,
                currency,
              }),
            ],
          );
          priceDrops += 1;
        }

        updated += 1;
      }

      const availability = await verifyKnownListings({
        radar,
        runId: runRecord.id,
        mercadoLivreAccessToken:
          mlConnection?.status === 'connected' ? mlConnection.access_token : null,
        ebayCredentials,
        seenKeys,
      });

      availabilityChecks = availability.checked;
      unavailable = availability.unavailable;
      restored = availability.restored;
      priceDrops += availability.price_drops;

      const sourceSummary = sourceRuns.map((source) => {
        const catalogFound = Array.isArray(source.catalog_items)
          ? source.catalog_items.length
          : 0;

        return {
          source: source.source,
          ok: Boolean(source.ok || catalogFound > 0),
          marketplace_ok: Boolean(source.ok),
          catalog_only: !source.ok && catalogFound > 0,
          skipped: Boolean(source.skipped),
          status: source.status || null,
          reason: source.reason || null,
          found: source.items?.length || 0,
          catalog_found: catalogFound,
          shipping_detail_checked:
            Number(source.shipping_detail_checked || 0),
          shipping_detail_enriched:
            Number(source.shipping_detail_enriched || 0),
        };
      });

      for (const source of sourceSummary.filter(
        (entry) =>
          !entry.ok &&
          !entry.skipped &&
          !entry.catalog_only,
      )) {
        await run(
          `INSERT INTO activity_events
            (radar_id, run_id, type, title, detail, metadata_json)
           VALUES (?, ?, 'source_error', ?, ?, ?)`,
          [
            radar.id,
            runRecord.id,
            `Falha em ${source.source}`,
            source.reason || `HTTP ${source.status || 'erro'}`,
            JSON.stringify(source),
          ],
        );
      }

      const activeSources = sourceSummary.filter((source) => source.ok).length;
      const unavailableSources = sourceSummary.filter((source) => !source.ok);
      let message = `${results.length} anúncios selecionados de ${activeSources} fonte(s). ${added} novos, ${updated} atualizados, ${priceDrops} queda(s) de preço, ${unavailable} indisponível(is) e ${restored} restaurado(s).`;

      if (criteriaRejected > 0) {
        message += `${criteriaRejected} resultado(s) barrado(s) pelos critérios do radar.`;
      }

      if (catalogItems.length) {
        message += ` Mercado Livre Catálogo: ${catalogAdded} pista(s) nova(s) e ${catalogUpdated} atualizada(s).`;
      }

      const ebaySummary = sourceSummary.find(
        (source) => source.source === "ebay",
      );

      if (ebaySummary?.shipping_detail_checked > 0) {
        message += ` eBay: frete detalhado consultado em ${ebaySummary.shipping_detail_checked} item(ns), ${ebaySummary.shipping_detail_enriched} com valor retornado.`;
      }

      if (visualEnabled || semanticEnabled) {
        message += ` Radar visual ativo (mínimo ${Math.round(minVisualSimilarity * 100)}%).`;
        if (semanticEnabled) message += ' IA visual semântica ativa.';
      }
      if (preferenceProfile.total_feedback > 0) {
        message += ` Perfil de gosto ativo com ${preferenceProfile.total_feedback} feedback(s).`;
      }

      if (unavailableSources.length) {
        const labels = unavailableSources
          .map((source) => {
            if (source.source === 'ebay' && source.reason === 'credentials_pending') {
              return 'eBay aguardando credenciais';
            }
            if (source.source === 'mercadolivre' && source.status === 403) {
              return 'Mercado Livre bloqueou busca geral (403)';
            }
            if (source.skipped) return `${source.source} não configurado`;
            return `${source.source} indisponível`;
          })
          .join('; ');
        message += ` ${labels}.`;
      }

      await run(
        `UPDATE radar_runs
         SET status = 'completed', sources_total = ?, sources_ok = ?, found_count = ?,
             added_count = ?, updated_count = ?, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [sourceSummary.length, activeSources, results.length, added, updated, runRecord.id],
      );

      await run(
        `INSERT INTO activity_events
          (radar_id, run_id, type, title, detail, metadata_json)
         VALUES (?, ?, 'run_completed', ?, ?, ?)`,
        [
          radar.id,
          runRecord.id,
          `Radar executado: ${radar.name}`,
          message,
          JSON.stringify({ sources: sourceSummary, added, updated, priceDrops, availabilityChecks, unavailable, restored, catalogAdded, catalogUpdated, criteriaRejected, trigger }),
        ],
      );

      if (radar.schedule_enabled) {
        const interval = Math.max(Number(radar.schedule_interval_minutes) || 240, 60);
        await run(
          `UPDATE radars
           SET next_run_at = datetime('now', '+' || ? || ' minutes')
           WHERE id = ?`,
          [interval, radar.id],
        );
      }

      return {
        ok: true,
        radar,
        run_id: runRecord.id,
        trigger,
        added,
        updated,
        price_drops: priceDrops,
        availability_checks: availabilityChecks,
        unavailable,
        restored,
        catalog_added: catalogAdded,
        catalog_updated: catalogUpdated,
        criteria_rejected: criteriaRejected,
        sources: sourceSummary,
        message,
      };
    } catch (err) {
      if (runRecord?.id) {
        await run(
          `UPDATE radar_runs
           SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [err.message, runRecord.id],
        ).catch(() => {});

        await run(
          `INSERT INTO activity_events
            (radar_id, run_id, type, title, detail)
           VALUES (?, ?, 'run_failed', 'Falha ao executar radar', ?)`,
          [runRecord.radar_id, runRecord.id, err.message],
        ).catch(() => {});
      }

      throw err;
    }
  }

  async function runDueRadars(limit = 5) {
    const due = await all(
      `SELECT * FROM radars
       WHERE schedule_enabled = 1
         AND (next_run_at IS NULL OR datetime(next_run_at) <= datetime('now'))
       ORDER BY COALESCE(next_run_at, created_at) ASC
       LIMIT ?`,
      [Math.min(Math.max(Number(limit) || 5, 1), 20)],
    );

    const results = [];
    for (const radar of due) {
      try {
        results.push(await executeRadarById(radar.id, { trigger: 'scheduled' }));
      } catch (err) {
        results.push({ ok: false, radar_id: radar.id, error: err.message });
      }
    }

    return { due: due.length, results };
  }

  return { executeRadarById, runDueRadars };
}

module.exports = { createRadarRunner };
