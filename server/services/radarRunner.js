const { searchAllSources } = require('./sources');

function createRadarRunner({ get, all, run, getValidMercadoLivreConnection }) {
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
      const sourceRuns = await searchAllSources({
        query: radar.query,
        mercadoLivreAccessToken:
          mlConnection?.status === 'connected' ? mlConnection.access_token : null,
        limit: 50,
      });

      const maxPrice = radar.max_price === null ? null : Number(radar.max_price);
      const successfulItems = sourceRuns.flatMap((source) =>
        source.ok ? source.items : [],
      );

      const results = successfulItems
        .filter((item) => {
          if (!item.url || !item.title) return false;
          if (maxPrice === null || Number.isNaN(maxPrice)) return true;
          if (item.currency && item.currency !== 'BRL') return true;
          return item.price === null || Number(item.price) <= maxPrice;
        })
        .slice(0, 60);

      let added = 0;
      let updated = 0;
      let priceDrops = 0;

      for (const item of results) {
        const existing = await get('SELECT * FROM listings WHERE url = ?', [item.url]);
        const nextPrice = item.price === null ? null : Number(item.price);
        const currency = item.currency || 'BRL';
        const sourceNote = item.external_id
          ? `ID ${item.platform}: ${item.external_id}`
          : null;

        if (!existing) {
          const insert = await run(
            `INSERT INTO listings
              (radar_id, title, platform, url, image_url, current_price, currency, status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'novo', ?)`,
            [
              radar.id,
              item.title,
              item.platform,
              item.url,
              item.image_url,
              nextPrice,
              currency,
              sourceNote,
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
              JSON.stringify({ url: item.url, platform: item.platform }),
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
           SET radar_id = ?, title = ?, platform = ?, image_url = ?,
               current_price = ?, currency = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            radar.id,
            item.title,
            item.platform,
            item.image_url,
            nextPrice,
            currency,
            existing.id,
          ],
        );

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

      const sourceSummary = sourceRuns.map((source) => ({
        source: source.source,
        ok: source.ok,
        skipped: Boolean(source.skipped),
        status: source.status || null,
        reason: source.reason || null,
        found: source.items?.length || 0,
      }));

      for (const source of sourceSummary.filter((entry) => !entry.ok && !entry.skipped)) {
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
      let message = `${results.length} anúncios recebidos de ${activeSources} fonte(s). ${added} novos, ${updated} atualizados e ${priceDrops} queda(s) de preço.`;

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
          JSON.stringify({ sources: sourceSummary, added, updated, priceDrops, trigger }),
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
