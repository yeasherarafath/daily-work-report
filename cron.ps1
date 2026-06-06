# powershell -ExecutionPolicy Bypass -File cron.ps1

# =========================
# CONFIG
# =========================

$env:OLLAMA_MODELS = "E:\YasirArafat\ollama-models"

$OLLAMA_PATH = "ollama"
$NODE_SCRIPT = "report.js"

$MAX_RETRIES = 5
$TIMEOUT = 300  # 5 min
$RETRY_DELAY = 60  # 1 min

# =========================
# FUNCTIONS
# =========================

function Stop-Ollama {
    Write-Host "Stopping Ollama..."

    taskkill /IM ollama.exe /F > $null 2>&1

    # wait until port is released
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $check = netstat -ano | findstr 11434
            if (-not $check) { return }
        } catch {}

        Start-Sleep -Seconds 1
    }
}

function Start-Ollama {
    Write-Host "Starting Ollama..."

    $check = netstat -ano | findstr 11434

    if ($check) {
        Write-Host "Ollama already running (port 11434 busy)"
        return
    }

    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
}

function Wait-Ollama {
    Write-Host "Waiting for Ollama..."

    Start-Sleep -Seconds 3

    for ($i = 0; $i -lt 40; $i++) {
        try {
            Invoke-RestMethod "http://127.0.0.1:11434/api/tags" -TimeoutSec 2 | Out-Null
            Write-Host "Ollama Ready"
            return
        } catch {
            Write-Host "Not ready... $i"
            Start-Sleep -Seconds 2
        }
    }

    throw "Ollama failed to start"
}

function Run-Node {
    Write-Host "Running Node script..."

    $process = Start-Process "node" `
        -ArgumentList $NODE_SCRIPT `
        -PassThru `
        -NoNewWindow

    $finished = $process.WaitForExit($TIMEOUT * 1000)

    if (-not $finished) {
        Write-Host "Timeout reached - killing process"
        $process.Kill()
        return $false
    }

    return ($process.ExitCode -eq 0)
}

# =========================
# MAIN FLOW
# =========================

try {
    Stop-Ollama
    Start-Sleep -Seconds 2

    Start-Ollama
    Wait-Ollama

    $success = $false

    for ($i = 1; $i -le $MAX_RETRIES; $i++) {

        Write-Host "`nAttempt $i / $MAX_RETRIES"

        $success = Run-Node

        if ($success) {
            Write-Host "Success"
            break
        }

        Write-Host "Failed"

        if ($i -lt $MAX_RETRIES) {
            Write-Host "Retrying in 1 minute..."
            Start-Sleep -Seconds $RETRY_DELAY
        }
    }

    if (-not $success) {
        Write-Host "All retries failed"
    }

}
finally {
    Stop-Ollama
    Write-Host "Done"
}