# Radar por imagem

O Radar 2.0 suporta radares híbridos de texto + imagem com duas camadas visuais: comparação perceptual clássica e IA visual semântica local.

## Fluxo

1. Ao criar um radar, o usuário pode enviar uma imagem JPEG ou PNG de referência.
2. O backend extrai uma assinatura visual clássica com dHash, histograma RGB, proporção e cor média.
3. No app desktop, o backend também gera um embedding semântico CLIP de 512 dimensões usando `Xenova/clip-vit-base-patch32` via Transformers.js/ONNX Runtime.
4. Quando um anúncio possui imagem, o Radar baixa uma cópia temporária, calcula as duas representações e compara com a referência.
5. O resultado recebe:
   - `visual_score`: semelhança perceptual clássica de 0 a 100;
   - `semantic_score`: semelhança semântica por embedding de 0 a 100;
   - `hybrid_score`: score final que combina imagem clássica, IA visual, palavras-chave e preço.
6. `min_visual_similarity` filtra resultados visualmente distantes usando a melhor evidência disponível entre o score clássico e o semântico.

A análise semântica acontece localmente no app desktop. As imagens não são enviadas para uma API externa de IA.

## IA visual semântica

O modo semântico usa um modelo CLIP quantizado (`q8`) e é ativado no sidecar desktop por `SEMANTIC_VISION_ENABLED=1`. O modelo é empacotado no instalador para evitar depender de download no primeiro uso. A build prepara o cache com:

```bash
cd desktop
npm run prepare:model
```

O cache empacotado fica em `src-tauri/resources/models/` e é ignorado pelo Git. A build final inclui esse diretório via `bundle.resources` do Tauri.

## Banco

Campos do radar:
- `visual_enabled`
- `visual_weight`
- `min_visual_similarity`
- `reference_image_path`
- `reference_features_json`
- `semantic_enabled`
- `semantic_weight`
- `reference_embedding_json`
- `semantic_model`

Campos do anúncio:
- `visual_score`
- `semantic_score`
- `hybrid_score`
- `image_features_json`
- `image_embedding_json`

## API

- `PUT /api/radars/:id/reference-image` envia e indexa a imagem de referência.
- `GET /api/radars/:id/reference-image` exibe a referência.
- `DELETE /api/radars/:id/reference-image` remove a referência visual e o embedding associado.
- `POST /api/radars/:id/reindex-visual` recalcula os anúncios já salvos, incluindo IA semântica quando disponível.
- `GET /api/semantic/status` informa se o motor semântico está ativo, carregado e qual modelo está sendo usado.

## Score

O `visual_weight` define quanto o conjunto visual pesa contra texto e preço. Dentro da parte visual, `semantic_weight` define quanto o embedding semântico pesa contra a assinatura clássica. Isso deixa o usuário escolher entre fidelidade visual literal e semelhança de estilo/conceito.

## Web x desktop

A versão web/Fly mantém o motor perceptual clássico e o schema completo, mas não carrega o modelo CLIP por padrão. Isso evita manter ONNX/modelo pesado no servidor. O desktop é a versão principal para IA semântica local.
