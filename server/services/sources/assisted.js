"use strict";

// Não anuncia busca automática onde não existe uma API homologada.
// A coleta é iniciada pelo usuário, usando cards visíveis no navegador.
function getAssistedSourceStatuses() {
  return {
    enjoei: {source:"enjoei",mode:"browser_bridge",automatic_api:false,assisted_import:true,
      note:"Colete anúncios visíveis com a extensão Radar 2.0 Bridge."},
    facebook: {source:"facebook",mode:"browser_bridge",automatic_api:false,assisted_import:true,
      note:"Capture anúncios visíveis do Marketplace. Login/CAPTCHA permanecem manuais."},
    vinted: {source:"vinted",mode:"browser_bridge",automatic_api:false,assisted_import:true,
      note:"Importação assistida, sem acesso a API de busca homologada."},
  };
}
module.exports={getAssistedSourceStatuses};
