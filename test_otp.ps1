$body = @{
    username = "testchk99"
    first_name = "Test"
    last_name = "User"
    email = "popipi5207@hiredify.com"
    password = "test123456"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "https://webpagetest-8jyd.onrender.com/api/auth/register" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body

Write-Host ($response | ConvertTo-Json)
