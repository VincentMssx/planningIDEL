$ErrorActionPreference = 'Stop'
$email = (Read-Host 'Adresse e-mail du compte administrateur local').Trim()
$password = Read-Host 'Mot de passe unique (20 caracteres minimum)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
try {
    $payload = @{
        email = $email
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } | ConvertTo-Json -Compress
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $payload | docker compose --project-directory (Join-Path $PSScriptRoot '..') run --rm -T fixtures operator
    if ($LASTEXITCODE -ne 0) { throw 'La creation du compte administrateur a echoue.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $password.Dispose()
    $payload = $null
}
