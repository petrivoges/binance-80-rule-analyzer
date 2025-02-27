$(document).ready(function() {
    // Initialize Select2 for coin selection
    $('#coins').select2({
        placeholder: "Search for coins (e.g., BTCUSDT)",
        maximumSelectionLength: 10,
        ajax: {
            url: 'https://api.binance.com/api/v3/exchangeInfo',
            dataType: 'json',
            delay: 250,
            processResults: function(data) {
                return {
                    results: data.symbols
                        .filter(symbol => symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING')
                        .map(symbol => ({ id: symbol.symbol, text: symbol.symbol }))
                };
            },
            cache: true
        }
    });

    // Analyze button click handler
    $('#analyze').click(async function() {
        const selectedCoins = $('#coins').val();
        const startDate = $('#startDate').val();
        const endDate = $('#endDate').val();

        // Input validation
        if (!selectedCoins || selectedCoins.length === 0) {
            alert('Please select at least one coin.');
            return;
        }
        if (selectedCoins.length > 10) {
            alert('Please select no more than 10 coins.');
            return;
        }
        if (!startDate || !endDate) {
            alert('Please select both start and end dates.');
            return;
        }
        if (new Date(startDate) > new Date(endDate)) {
            alert('Start date must be before end date.');
            return;
        }

        // Show loading indicator
        $('#results').html('');
        $('#loading').show();

        try {
            const results = await analyzeCoins(selectedCoins, startDate, endDate);
            displayResults(results, selectedCoins, startDate, endDate);
        } catch (error) {
            console.error('Analysis failed:', error);
            $('#results').html('<div class="alert alert-danger">An error occurred during analysis. Please check your internet connection and try again.</div>');
        } finally {
            $('#loading').hide();
        }
    });
});

// Fetch k-line data from Binance API
async function fetchKlines(coin, interval, date) {
    const startTime = new Date(date + 'T00:00:00Z').getTime();
    const endTime = startTime + 86400000; // 24 hours in milliseconds
    try {
        const response = await fetch(
            `https://api.binance.com/api/v3/klines?symbol=${coin}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`
        );
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            throw new Error('No data returned from API');
        }
        return data.map(d => ({
            open: parseFloat(d[1]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
    } catch (error) {
        console.error(`Error fetching ${interval} klines for ${coin} on ${date}:`, error);
        return null;
    }
}

// Calculate value area (VAL and VAH) from 5-minute klines
function calculateValueArea(klines) {
    if (!klines || klines.length === 0) return null;

    const priceVolume = {};
    let totalVolume = 0;
    klines.forEach(k => {
        const price = Math.round(k.close * 100) / 100; // Round to 2 decimal places
        priceVolume[price] = (priceVolume[price] || 0) + k.volume;
        totalVolume += k.volume;
    });

    // Find Point of Control (POC)
    const poc = Object.entries(priceVolume).reduce((a, b) => a[1] > b[1] ? a : b)[0];
    const sortedPrices = Object.keys(priceVolume).map(Number).sort((a, b) => a - b);
    let coveredVolume = priceVolume[poc];
    let val = Number(poc);
    let vah = Number(poc);

    // Expand from POC to cover 70% of volume
    while (coveredVolume < 0.7 * totalVolume) {
        const valIdx = sortedPrices.indexOf(val);
        const vahIdx = sortedPrices.indexOf(vah);
        const below = valIdx > 0 ? sortedPrices[valIdx - 1] : null;
        const above = vahIdx < sortedPrices.length - 1 ? sortedPrices[vahIdx + 1] : null;

        const belowVolume = below ? priceVolume[below] : 0;
        const aboveVolume = above ? priceVolume[above] : 0;

        if (below && (!above || belowVolume >= aboveVolume)) {
            val = below;
            coveredVolume += belowVolume;
        } else if (above) {
            vah = above;
            coveredVolume += aboveVolume;
        } else {
            break;
        }
    }
    return { val, vah };
}

// Analyze a single coin for a single day
async function analyzeCoinForDay(coin, date) {
    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().split('T')[0];

    // Fetch and calculate value area from previous day
    const prevKlines = await fetchKlines(coin, '5m', prevDayStr);
    if (!prevKlines) return null;

    const valueArea = calculateValueArea(prevKlines);
    if (!valueArea) return null;

    // Fetch current day's 30-minute klines
    const currentKlines = await fetchKlines(coin, '30m', date);
    if (!currentKlines || currentKlines.length < 2) return null;

    // Check 80% rule condition
    const openPrice = currentKlines[0].open;
    if (openPrice >= valueArea.val) {
        return null; // Open not below VAL, no trade
    }

    // Find first two consecutive 30m bars with close > VAL
    for (let i = 1; i < currentKlines.length; i++) {
        if (currentKlines[i-1].close > valueArea.val && currentKlines[i].close > valueArea.val) {
            const buyPrice = currentKlines[i].close;
            const sellPrice = currentKlines[currentKlines.length - 1].close;
            const roi = ((sellPrice - buyPrice) / buyPrice) * 100;
            return roi;
        }
    }
    return null; // No trade condition met
}

// Analyze all selected coins over the date range
async function analyzeCoins(coins, startDate, endDate) {
    const dates = getDatesInRange(startDate, endDate);
    const results = {};

    for (const date of dates) {
        results[date] = {};
        for (const coin of coins) {
            results[date][coin] = await analyzeCoinForDay(coin, date);
            // Delay to respect Binance API rate limits (e.g., 1200 requests/minute)
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    return results;
}

// Get array of dates in the range
function getDatesInRange(start, end) {
    const dates = [];
    let current = new Date(start);
    const endDate = new Date(end);
    while (current <= endDate) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

// Display results in a table
function displayResults(results, coins, startDate, endDate) {
    const table = $('<table class="table table-bordered table-hover"></table>');
    const headerRow = $('<tr><th scope="col">Date</th></tr>');
    coins.forEach(coin => headerRow.append(`<th scope="col">${coin}</th>`));
    table.append(headerRow);

    const dates = getDatesInRange(startDate, endDate);
    dates.forEach(date => {
        const row = $(`<tr><td>${date}</td></tr>`);
        coins.forEach(coin => {
            const roi = results[date][coin];
            const cell = $('<td></td>');
            if (roi !== null && !isNaN(roi)) {
                cell.text(roi.toFixed(2) + '%');
                if (roi > 3) cell.addClass('green');
                else if (roi > 0) cell.addClass('yellow');
                else cell.addClass('red');
            } else {
                cell.text('–');
            }
            row.append(cell);
        });
        table.append(row);
    });

    $('#results').html(table);
}
