param(
    [switch]$CheckOnly,
    [switch]$DownloadOnly,
    [switch]$AutoInstall,
    [switch]$Force
)

# Radar 2.0: updater for official Windows releases.
# With -AutoInstall it closes the app automatically after waiting for
# active searches, then uses the silent installer.
# Works with Windows PowerShell 5.1 and PowerShell 7+.
$ErrorActionPreference = "Stop"
$api = "https://api.github.com/repos/littleghoost/radar-2.0/releases/latest"

function Get-InstalledRadarVersion {
    $locations = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($location in $locations) {
        $entries = @(Get-ItemProperty -Path $location -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match '^Radar 2\.0(?:\s|$)' -and $_.DisplayVersion })
        foreach ($entry in $entries) {
            if ($entry.DisplayVersion -match '^\d+\.\d+\.\d+$') {
                return [version]$entry.DisplayVersion
            }
        }
    }
    return $null
}

function Get-RadarProcesses {
    return @(Get-Process -Name "radar-2-0-desktop" -ErrorAction SilentlyContinue)
}

function Wait-ForRadarExit([int]$TimeoutSeconds = 240) {
    for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
        if ((Get-RadarProcesses).Count -eq 0) { return $true }
        Start-Sleep -Seconds 1
    }
    return (Get-RadarProcesses).Count -eq 0
}

function Close-RadarForUpdate {
    if ((Get-RadarProcesses).Count -eq 0) { return }

    $controlPath = Join-Path $env:APPDATA "com.littleghoost.radar2\update-control.json"
    $prepared = $false

    if (Test-Path -LiteralPath $controlPath) {
        try {
            $control = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
            if ($control.protocol -eq 1 -and $control.port -eq 3130 -and
                [string]$control.token -match '^[a-f0-9]{64}$') {
                $result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3130/api/desktop/update/prepare-shutdown" `
                    -Headers @{ "x-radar-update-token" = [string]$control.token } `
                    -ContentType "application/json" -Body '{}' -TimeoutSec 8
                $prepared = [bool]$result.shutdown_requested
            }
        } catch {
            Write-Host "Desligamento protegido indisponivel nesta versao; verificando modo de compatibilidade."
        }
    }

    if ($prepared) {
        Write-Host "Radar preparando encerramento seguro: novas buscas pausadas."
        Write-Host "Aguardando as buscas ativas terminarem e o aplicativo fechar..."
        if (-not (Wait-ForRadarExit -TimeoutSeconds 240)) {
            throw "O Radar nao concluiu as buscas no prazo. Nenhum processo foi encerrado a forca."
        }
    } else {
        # Compatibilidade com versões antigas que não implementam
        # prepare-shutdown. Nunca encerra se não puder verificar as buscas.
        Write-Host "Radar antigo: verificando buscas ativas antes do fechamento..."
        $safeToStop = $false
        for ($attempt = 0; $attempt -lt 90; $attempt++) {
            try {
                $runs = @(Invoke-RestMethod -Uri "http://127.0.0.1:3130/api/runs?limit=200" -TimeoutSec 8)
                $active = @($runs | Where-Object { $_.status -eq "running" }).Count
                if ($active -eq 0) {
                    Start-Sleep -Seconds 2
                    $recheck = @(Invoke-RestMethod -Uri "http://127.0.0.1:3130/api/runs?limit=200" -TimeoutSec 8)
                    if (@($recheck | Where-Object { $_.status -eq "running" }).Count -eq 0) {
                        $safeToStop = $true
                        break
                    }
                }
                Write-Host "Aguardando $active busca(s) terminar(em)..."
            } catch {
                throw "Nao foi possivel confirmar buscas inativas. Encerramento automatico cancelado."
            }
            Start-Sleep -Seconds 2
        }
        if (-not $safeToStop) {
            throw "Ainda ha buscas em execucao. Atualizacao cancelada para proteger os dados."
        }

        # Apenas para instalações anteriores ao protocolo protegido.
        # O Windows encerra a arvore de processos uma vez que a API
        # confirmou que os radares nao estao fazendo buscas.
        $processes = @(Get-RadarProcesses)
        foreach ($process in $processes) {
            Write-Host "Fechando Radar antigo ocioso (PID $($process.Id))..."
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "O Windows nao conseguiu encerrar o Radar antigo."
            }
        }
        if (-not (Wait-ForRadarExit -TimeoutSeconds 20)) {
            throw "O Radar continuou aberto apos o comando de encerramento."
        }
    }

    # Aguarda o backend liberar os arquivos do banco local.
    Start-Sleep -Seconds 2
    Write-Host "Radar fechado. Instalacao autorizada."
}

try {
    Write-Host "Radar 2.0 | Verificando a ultima versao oficial no GitHub..."
    $release = Invoke-RestMethod -Uri $api -Headers @{
        "Accept" = "application/vnd.github+json"
        "User-Agent" = "Radar-2.0-PowerShell-Updater"
        "X-GitHub-Api-Version" = "2022-11-28"
    } -TimeoutSec 20

    if ($release.draft -or $release.prerelease -or
        $release.tag_name -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
        throw "O GitHub nao retornou uma versao estavel valida."
    }

    $latest = [version]($release.tag_name -replace '^v','')
    $expectedName = "Radar.2.0_$($latest.ToString())_x64-setup.exe"
    $asset = @($release.assets | Where-Object { $_.name -eq $expectedName } |
        Select-Object -First 1)
    if ($asset.Count -ne 1) {
        throw "Nao encontrei o instalador oficial Windows na versao $latest."
    }
    $asset = $asset[0]
    $trustedUrl = "https://github.com/littleghoost/radar-2.0/releases/download/$($release.tag_name)/$expectedName"
    if ([string]$asset.browser_download_url -cne $trustedUrl) {
        throw "A URL do instalador nao corresponde ao repositorio oficial."
    }

    $expectedDigest = [string]$asset.digest
    if ($expectedDigest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
        throw "O Release nao fornece SHA-256 para verificar o instalador. Download cancelado."
    }
    $expectedHash = $Matches[1].ToUpperInvariant()

    $installed = Get-InstalledRadarVersion
    if ($null -ne $installed) {
        Write-Host "Versao instalada: $installed"
    } else {
        Write-Host "Versao instalada: nao identificada pelo Windows."
    }
    Write-Host "Ultima versao oficial: $latest"

    if ($null -ne $installed -and $installed -ge $latest -and -not $Force) {
        Write-Host "O Radar ja esta atualizado. Use -Force para baixar novamente."
        exit 0
    }

    if ($CheckOnly) {
        Write-Host "Ha uma versao disponivel para instalar."
        Write-Host "Pagina oficial: $($release.html_url)"
        exit 0
    }

    $directory = Join-Path $env:TEMP "Radar2-Updates"
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -Path $directory -ItemType Directory -Force | Out-Null
    }
    $installer = Join-Path $directory $expectedName

    $cachedValid = $false
    if (Test-Path -LiteralPath $installer) {
        $cachedHash = (Get-FileHash -Path $installer -Algorithm SHA256).Hash
        $cachedValid = $cachedHash -eq $expectedHash
    }
    if ($cachedValid) {
        Write-Host "Instalador ja baixado e verificado. Reutilizando."
    } else {
        if (Test-Path -LiteralPath $installer) {
            Remove-Item -LiteralPath $installer -Force
        }
        $partial = "$installer.partial"
        $curl = Get-Command "curl.exe" -ErrorAction SilentlyContinue
        $partialFile = Get-Item -LiteralPath $partial -ErrorAction SilentlyContinue
        if ($null -ne $partialFile -and [long]$partialFile.Length -ge [long]$asset.size) {
            Remove-Item -LiteralPath $partial -Force
            $partialFile = $null
        }

        if ($null -ne $curl) {
            Write-Host "Baixando com curl.exe (mais eficiente para arquivos grandes)..."
            $curlArgs = @(
                "--location",
                "--fail",
                "--show-error",
                "--progress-bar",
                "--retry", "2",
                "--retry-delay", "2",
                "--connect-timeout", "20",
                "--max-time", "900",
                "--output", $partial
            )
            if ($null -ne $partialFile -and $partialFile.Length -gt 0) {
                Write-Host "Tentando retomar $([Math]::Round($partialFile.Length / 1MB, 1)) MB ja baixados..."
                $curlArgs += @("--continue-at", "-")
            }
            & $curl.Source @curlArgs $trustedUrl
            if ($LASTEXITCODE -ne 0) {
                throw "curl.exe falhou (codigo $LASTEXITCODE). Rode o comando novamente para tentar retomar."
            }
        } else {
            Write-Host "curl.exe indisponivel. Usando PowerShell sem barra de progresso..."
            $oldProgressPreference = $ProgressPreference
            try {
                $ProgressPreference = "SilentlyContinue"
                Invoke-WebRequest -Uri $trustedUrl -OutFile $partial -UseBasicParsing -TimeoutSec 900
            } finally {
                $ProgressPreference = $oldProgressPreference
            }
        }

        $actualHash = (Get-FileHash -Path $partial -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedHash) {
            Remove-Item -LiteralPath $partial -Force
            throw "SHA-256 diferente do publicado no GitHub. Arquivo descartado. Instalacao cancelada."
        }
        Move-Item -LiteralPath $partial -Destination $installer -Force
    }

    Write-Host "SHA-256 verificado com sucesso."
    Write-Host "Arquivo: $installer"

    if ($DownloadOnly) {
        Write-Host "Download concluido. A instalacao nao foi iniciada."
        exit 0
    }

    if ($AutoInstall) {
        Close-RadarForUpdate
    } elseif ((Get-RadarProcesses).Count -gt 0) {
        Write-Host "Feche o Radar pelo icone na bandeja antes de instalar."
        [void](Read-Host "Apos escolher Sair do Radar, pressione Enter")
        if ((Get-RadarProcesses).Count -gt 0) {
            throw "O Radar ainda esta aberto. Instalador baixado, mas nao executado."
        }
    }

    if ($AutoInstall) {
        # NSIS uses /S for a quiet installation. Explicit opt-in is required.
        # Modern versions exit gracefully after all radar runs finish.
        # Legacy installations are closed only after confirming no active runs.
        Write-Host "Instalando Radar $latest automaticamente (NSIS /S)..."
        $process = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru -Wait
        if ($process.ExitCode -ne 0) {
            throw "O instalador terminou com codigo $($process.ExitCode)."
        }

        # Some installers update the uninstall registry asynchronously.
        $confirmed = $false
        for ($attempt = 0; $attempt -lt 8; $attempt++) {
            $current = Get-InstalledRadarVersion
            if ($null -ne $current -and $current -ge $latest) {
                $confirmed = $true
                break
            }
            Start-Sleep -Seconds 1
        }
        if (-not $confirmed) {
            throw "O instalador terminou, mas nao consegui confirmar a nova versao no registro do Windows. Verifique em Aplicativos instalados."
        }
        Write-Host "Radar 2.0 atualizado com sucesso: $latest"
        Write-Host "Abra o Radar normalmente para continuar suas buscas."
    } else {
        Write-Host "Abrindo o instalador oficial. Siga as instrucoes do Windows..."
        Start-Process -FilePath $installer
    }
} catch {
    Write-Error "Falha ao atualizar o Radar: $($_.Exception.Message)"
    exit 1
}
