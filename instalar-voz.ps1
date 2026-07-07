# Instala a VOZ COMPLETA (XTTS v2 + faster-whisper) do Hermes Assistente.
# Recomendado apenas com GPU NVIDIA (6+ GB de VRAM). Sem GPU, a voz leve do app
# já funciona — este script é um upgrade opcional de qualidade.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vs = Join-Path $root 'voice-server'
if (-not (Test-Path $vs)) { throw "Pasta voice-server não encontrada ao lado deste script." }

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "Instalando o gerenciador uv..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

Set-Location $vs
Write-Host "Criando ambiente Python 3.11..."
uv venv --python 3.11 .venv

$gpu = [bool](Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' })
if ($gpu) {
    Write-Host "GPU NVIDIA detectada - instalando PyTorch CUDA (download grande, ~2,5 GB)..."
    uv pip install --python .venv torch torchaudio --index-url https://download.pytorch.org/whl/cu124
} else {
    Write-Host "AVISO: sem GPU NVIDIA. A voz completa ficara LENTA em CPU - considere ficar na voz leve."
    uv pip install --python .venv torch torchaudio
}

Write-Host "Instalando dependencias de voz..."
uv pip install --python .venv -r requirements.txt

# aponta o app para este voice-server e ativa o motor XTTS
$sf = "$env:APPDATA\hermes-assistente\settings.json"
New-Item -ItemType Directory -Force (Split-Path $sf) | Out-Null
if (Test-Path $sf) {
    $j = Get-Content $sf -Raw | ConvertFrom-Json
} else {
    $j = [pscustomobject]@{}
}
$j | Add-Member -NotePropertyName voiceServerDir -NotePropertyValue $vs -Force
$j | Add-Member -NotePropertyName voiceEngine -NotePropertyValue 'xtts' -Force
[IO.File]::WriteAllText($sf, ($j | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Voz completa instalada! Reinicie o Hermes Assistente."
Write-Host "Na primeira conversa os modelos de voz (~3,5 GB) serao baixados automaticamente."
