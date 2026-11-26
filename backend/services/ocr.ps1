param(
    [Parameter(Mandatory=$true)][string]$ImageDir,
    [Parameter(Mandatory=$true)][string]$OutFile,
    [string]$Language = "ru"
)

# OCR страниц-сканов встроенным движком Windows (Windows.Media.Ocr).
# Вызывается из backend/services/reports_service.py: страницы без текстового
# слоя рендерятся в PNG, здесь распознаются, результат — JSON:
#   [ { "name": "p0005.png", "lines": [ { "words": [ {t,x,y,w,h} ] } ] } ]
# Координаты слов — в пикселях изображения (пересчёт в пункты PDF делает Python).
#
# Зависимостей нет: используется языковой пакет OCR Windows. Если русского
# пакета нет, движок берётся по языкам пользователя; если и его нет — код 2.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] | Out-Null

$engine = $null
try {
    $lang = New-Object Windows.Globalization.Language $Language
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
} catch {}
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
    Write-Error "Windows OCR: нет движка распознавания для языка '$Language'."
    exit 2
}

$files = Get-ChildItem -Path $ImageDir -Filter *.png | Sort-Object Name
$result = @()

foreach ($file in $files) {
    $storageFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    $lines = @()
    foreach ($line in $ocr.Lines) {
        $words = @()
        foreach ($word in $line.Words) {
            $r = $word.BoundingRect
            $words += [pscustomobject]@{
                t = $word.Text
                x = [math]::Round($r.X, 2)
                y = [math]::Round($r.Y, 2)
                w = [math]::Round($r.Width, 2)
                h = [math]::Round($r.Height, 2)
            }
        }
        $lines += [pscustomobject]@{ words = $words }
    }
    $result += [pscustomobject]@{ name = $file.Name; lines = $lines }
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
