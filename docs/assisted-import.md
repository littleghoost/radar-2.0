# Importação assistida / Browser Bridge

O Browser Bridge aumenta a cobertura do Radar em marketplaces que não oferecem uma API oficial de busca geral adequada ao projeto.

## Princípio

O Radar **não** faz login no marketplace, não armazena cookies/senhas e não tenta contornar bloqueios anti-bot. A captura acontece por ação explícita do usuário, dentro de uma página que ele já abriu no próprio navegador, e lê somente elementos que já estão presentes no DOM da página.

## Fluxo

1. No Radar, abra **Importar página** e clique em **Copiar coletor**.
2. Crie um favorito/bookmark no navegador e use o código copiado como URL.
3. Abra normalmente uma página de resultados do marketplace.
4. Clique no favorito do Radar.
5. O coletor identifica cards visíveis com link + imagem, tenta extrair título/preço/moeda e copia um JSON para a área de transferência.
6. Volte ao Radar, clique em **Colar do clipboard**, escolha o radar de destino e importe.
7. Os anúncios entram no mesmo pipeline de deduplicação, IA visual, perfil aprendido e Grail Score.

## Plataformas

O coletor é genérico, com identificação de nome para OLX, Enjoei, Depop, Vinted, Facebook Marketplace, eBay, Mercado Livre/Mercado Libre e fallback para o domínio atual.

Como cada site pode mudar o HTML a qualquer momento, o coletor usa heurísticas de cards visíveis em vez de depender de seletores privados/ocultos. Uma captura pode trazer menos itens em layouts incomuns; isso não dispara uma tentativa de bypass.

## API local

`POST /api/import/assisted`

Exemplo:

```json
{
  "radar_id": 1,
  "source_url": "https://marketplace.example/busca",
  "items": [
    {
      "title": "Calça baggy vintage",
      "platform": "Marketplace",
      "url": "https://marketplace.example/item/123",
      "image_url": "https://cdn.example/image.jpg",
      "current_price": 120,
      "currency": "BRL"
    }
  ]
}
```

A rota aceita no máximo 100 itens por lote, valida URLs HTTP/HTTPS, ignora URLs duplicadas e passa os anúncios importados por `scoreListingForRadar` antes de salvá-los.
