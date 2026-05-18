$loginUri = "http://127.0.0.1:4006/api/v1/auth/login"
$loginBody = "{\`"email\`":\`"admin@dvi.co.in\`",\`"password\`":\`"Keerthi@2404ias\`"}"
try {
    $loginResponse = Invoke-RestMethod -Method Post -Uri $loginUri -Body $loginBody -ContentType "application/json"
    $token = $loginResponse.data.token
    if ($token) {
        $headers = @{ Authorization = "Bearer $token" }
        $response = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:4006/api/v1/itineraries/edit/381" -Headers $headers
        $plan = $response.data.plan
        $out = @{
            top_keys = $response.PSObject.Properties.Name
            data_keys = $response.data.PSObject.Properties.Name
            plan_keys = $plan.PSObject.Properties.Name
            first_route_keys = $plan.routes[0].PSObject.Properties.Name
            first_vehicle_keys = $plan.vehicles[0].PSObject.Properties.Name
            first_traveller_keys = $plan.travellers[0].PSObject.Properties.Name
            sample = @{
                arrival = $plan.arrival
                departure = $plan.departure
                arrival_date = $plan.arrival_date
                departure_date = $plan.departure_date
                hotel_category = $plan.hotel_category
                hotel_facilities = $plan.hotel_facilities
                pax_count = $plan.pax_count
                adults = $plan.adults
                children = $plan.children
            }
        }
        $out | ConvertTo-Json -Depth 5
    } else {
        $loginResponse | ConvertTo-Json -Depth 5
    }
} catch {
    $_.Exception.Message
}
