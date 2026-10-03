# Aprendizado de preferência (Grail Score)

O Radar 2.0 usa o feedback explícito do usuário para personalizar a ordem dos anúncios sem treinar um modelo externo.

## Sinais usados

- `interessante`: exemplo positivo.
- `descartado`: exemplo negativo.
- embeddings CLIP já calculados para as imagens dos anúncios.
- categoria do radar (`roupas`, `cameras`, etc.) para manter perfis separados.

`vendido` não é tratado como gosto positivo ou negativo, porque pode significar apenas indisponibilidade.

## Perfil

Para cada categoria, o backend calcula:

- centróide dos embeddings marcados como interessantes;
- centróide dos embeddings descartados;
- quantidade de feedbacks positivos e negativos.

O `preference_score` de um anúncio mede proximidade com o centróide positivo e distância do negativo. O peso do perfil aumenta gradualmente conforme o número de feedbacks cresce, evitando sobreajuste com uma ou duas marcações.

## Grail Score

O `grail_score` combina o `hybrid_score` já existente com o `preference_score` aprendido. No início, a preferência pessoal pesa pouco; com oito ou mais feedbacks válidos, ela pode chegar a 45% do score final.

Quando ainda não há feedback, o `grail_score` é igual ao score híbrido existente.

## Atualização automática

Ao mudar um anúncio para `interessante` ou `descartado`, ou ao remover um anúncio desses estados, o Radar recalcula os scores da mesma categoria. Novos resultados do runner já recebem o perfil atual durante a busca.

## API

- `GET /api/preferences/status`: mostra progresso por categoria.
- `POST /api/preferences/rebuild`: força a reconstrução dos scores; aceita `category` opcional.

## Interface

A página Perfil exibe a quantidade de exemplos positivos/negativos por categoria e permite recalcular o perfil manualmente. Os cards dos anúncios mostram `Grail` e `Seu gosto` quando há dados suficientes.
