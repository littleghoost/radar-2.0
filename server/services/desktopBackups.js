"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const sqlite3 = require("sqlite3");

function isoDate(now) {
  return now.toISOString().slice(0,10);
}

// Backup consistente: SQLite Backup API copia também dados presentes no WAL.
// Mantém versões diárias locais, nunca envia o banco para a nuvem.
function createDesktopBackupService({db,dataDir,keep=7,now=()=>new Date()}) {
  if (!db || !dataDir) throw new Error("Banco e diretório são obrigatórios.");
  const backupDir=path.join(dataDir,"backups");
  let running=false;
  async function run() {
    if (running) return {ok:true,skipped:true,reason:"busy"};
    running=true;
    const date=isoDate(now());
    const target=path.join(backupDir,"radar-"+date+".db");
    const partial=target+".partial";
    try {
      await fs.mkdir(backupDir,{recursive:true,mode:0o700});
      if (await fs.stat(target).catch(()=>null)) {
        return {ok:true,skipped:true,reason:"already_backed_up",target};
      }
      await new Promise((resolve,reject)=>{
        const backup=db.backup(partial);
        // db.backup() apenas inicializa o objeto; copiar páginas exige step().
        let tries=0;
        function next() {
          backup.step(-1,(error,done)=>{
            if(error) return reject(error);
            if(done) return resolve();
            if(++tries>30) return reject(new Error("Backup SQLite demorou demais."));
            setTimeout(next,200);
          });
        }
        next();
      });
      // A cópia precisa estar íntegra antes de substituir qualquer arquivo final.
      const result=await new Promise((resolve,reject)=>{
        const verification=new sqlite3.Database(partial,sqlite3.OPEN_READONLY,error=>{
          if(error)return reject(error);
          verification.get("PRAGMA integrity_check",[],(queryError,row)=>{
            // Fechar antes de renomear: no Windows, arquivos SQLite abertos
            // não podem ser renomeados com segurança.
            verification.close(closeError=>{
              if(queryError || closeError) return reject(queryError || closeError);
              resolve(row?.integrity_check);
            });
          });
        });
      });
      if(result!=="ok")throw new Error("Backup SQLite não passou em integrity_check.");
      await fs.rename(partial,target);
      const list=(await fs.readdir(backupDir))
        .filter(name=>/^radar-\d{4}-\d{2}-\d{2}\.db$/.test(name))
        .sort().reverse();
      for(const old of list.slice(Math.max(1,keep))) {
        await fs.unlink(path.join(backupDir,old)).catch(()=>{});
      }
      return {ok:true,skipped:false,target};
    } catch(error) {
      await fs.unlink(partial).catch(()=>{});
      throw error;
    } finally {
      running=false;
    }
  }
  return {run,backupDir};
}

module.exports={createDesktopBackupService};
