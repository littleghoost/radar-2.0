param(
    [switch]$CheckOnly,
    [switch]$DownloadOnly,
    [switch]$AutoInstall,
    [switch]$Force
)

# Radar 2.0: updater for official Windows releases.
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
        Write-Host "Baixando o instalador oficial..."
        $partial = "$installer.partial"
        try {
            Invoke-WebRequest -Uri $trustedUrl -OutFile $partial -TimeoutSec 180
            $actualHash = (Get-FileHash -Path $partial -Algorithm SHA256).Hash
            if ($actualHash -ne $expectedHash) {
                throw "SHA-256 diferente do publicado no GitHub. Instalacao cancelada."
            }
            Move-Item -LiteralPath $partial -Destination $installer -Force
        } finally {
            if (Test-Path -LiteralPath $partial) {
                Remove-Item -LiteralPath $partial -Force
            }
        }
    }

    Write-Host "SHA-256 verificado com sucesso."
    Write-Host "Arquivo: $installer"

    if ($DownloadOnly) {
        Write-Host "Download concluido. A instalacao nao foi iniciada."
        exit 0
    }

    $running = @(Get-Process -Name "radar-2-0-desktop" -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Host ""
        Write-Host "O Radar esta rodando em segundo plano!"
        Write-Host "Clique com o botao direito no icone do Radar, perto do relogio do Windows,"
        Write-Host "e escolha 'Sair do Radar' antes de continuar."
        if ($AutoInstall) {
            Write-Host "Aguardando o Radar fechar (ate 2 minutos). A instalacao continuara sozinha..."
            for ($attempt = 0; $attempt -lt 120; $attempt++) {
                if (@(Get-Process -Name "radar-2-0-desktop" -ErrorAction SilentlyContinue).Count -eq 0) {
                    break
                }
                Start-Sleep -Seconds 1
            }
        } else {
            [void](Read-Host "Depois de sair completamente, pressione Enter")
        }
        if (@(Get-Process -Name "radar-2-0-desktop" -ErrorAction SilentlyContinue).Count -gt 0) {
            throw "O Radar ainda esta aberto. Instalador baixado, mas nao executado."
        }
    }

    if ($AutoInstall) {
        # NSIS uses /S for a quiet installation. Explicit opt-in is required.
        # Never kill the app: the user must close it from the tray first so
        # any ongoing radar search can finish and the SQLite DB can close.
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
