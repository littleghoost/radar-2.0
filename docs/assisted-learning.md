# Treinamento assistido do Radar — Desktop 0.2.12 / Bridge 0.4.4

## Fluxo
1. A Bridge verifica itens capturados antes de enviar ao Desktop: candidatos, revisar e fora do filtro. Só os claramente errados são ignorados por padrão. O usuário pode permitir manualmente os excluídos.
2. Abra Dashboard → Anúncios → **Treinar IA · Validar peças** e selecione Grails / Roupas Raras ou Handycam NightShot / HDD.
3. Avalie com **É rara / gostei**, **É comum / não quero** ou **Não sei · Pular**.
4. A avaliação é persistida em `listing_training_feedback` e respeita o radar escolhido; rótulos raros/comuns mudam os status já existentes para interessante/descartado. Não sei não altera o status e evita a mesma pergunta até mudança explícita futura.
5. O Radar recalcula o perfil de preferência da categoria. Imagens com embeddings alimentam similaridade visual; quando não há embedding, aplica aprendizagem textual conservadora. O rótulo visual não é inventado: a interface informa quando falta.

## Proteções
- Itens ambíguos não são rejeitados, são enviados a uma revisão humana.
- Duplicatas e links continuam sendo verificados pelo backend.
- Uma peça com rótulo anterior não é perguntada novamente.
- O treinamento é voluntário; não há popups que interrompam a navegação.
- O banco do usuário não é alterado por testes. Na instalação, a única migração necessária é uma tabela nova sem modificação dos anúncios existentes.
- Perfis e classes são separados por radar/categoria, sem mistura entre roupas e câmeras.

## Limitações
- O classificador de pré-importação usa sinais de texto, URL e categoria; **não prova autenticidade, raridade ou NightShot**.
- O perfil visual depende da existência de embeddings calculados. No Grails há anúncios sem embeddings: para eles, o feedback começa pelo texto; será útil reindexar imagens no futuro.
- O modelo melhora a ordenação à medida que recebe feedback; seus exemplos não transformam automaticamente o sistema em um detector visual perfeito.
