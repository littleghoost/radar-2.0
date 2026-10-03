# Radar por imagem

O Radar 2.0 suporta radares híbridos de texto + imagem.

## Fluxo

1. Ao criar um radar, o usuário pode enviar uma imagem JPEG ou PNG de referência.
2. O backend extrai localmente uma assinatura visual com:
   - dHash perceptual de 64 bits;
   - histograma RGB quantizado em 64 bins;
   - proporção da imagem;
   - cor média.
3. Quando um anúncio possui imagem, o Radar baixa uma cópia temporária, extrai a mesma assinatura e calcula similaridade visual.
4. O resultado recebe dois valores:
   - `visual_score`: semelhança da imagem de 0 a 100;
   - `hybrid_score`: combinação de imagem, palavras-chave e preço de 0 a 100.
5. Radares visuais podem usar `min_visual_similarity` para descartar resultados visualmente distantes antes de chegar ao feed.

A análise acontece no próprio backend e não envia as imagens para um serviço de IA externo.

## Banco

Campos do radar:
- `visual_enabled`
- `visual_weight`
- `min_visual_similarity`
- `reference_image_path`
- `reference_features_json`

Campos do anúncio:
- `visual_score`
- `hybrid_score`
- `image_features_json`

## API

- `PUT /api/radars/:id/reference-image` envia a imagem de referência.
- `GET /api/radars/:id/reference-image` exibe a referência.
- `DELETE /api/radars/:id/reference-image` remove o modo visual.
- `POST /api/radars/:id/reindex-visual` recalcula os anúncios já salvos naquele radar.

## Limites atuais

O motor local atual lê JPEG e PNG e mede semelhança perceptual/visual. Ele é bom para forma geral, composição e paleta, mas ainda não é um embedding semântico estilo CLIP. Uma camada semântica futura pode ser adicionada por cima sem alterar o schema ou o fluxo do Radar.
