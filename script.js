$(document).ready(function() {
    initCoinSelect();
    $('#analyze').click(analyzeData);
});

// Initialize coin dropdown with top 100 coins and search functionality
async function initCoinSelect() {
    try {
        const top100Symbols = await fetchTopCoins();
        const top100Options = top100Symbols.map(symbol => ({ id: symbol, text: symbol }));

        $('#coins').select2({
            data: top100Options,
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
            },
            placeholder: "Select or search for coins (e.g., BTCUSDT)",
            maximumSelectionLength: 10,
            width: '100%'
        });
    } catch (error) {
        console.error('Error initializing coin select:', error);
        alert('Failed to load coin list. Please try again later.');
    }
}

// Fetch top 100 coins by trading volume
async function fetchTopCoins() {
    const exchangeInfoResponse = await fetch('https://api.binance.com/api/v3/exchangeInfo');
    const exchangeInfo = await exchangeInfoResponse.json();
    const usdtSymbols = exchangeInfo.symbols
        .filter(symbol => symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING')
        .map(symbol => symbol.symbol);

    const tickerResponse = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${JSON.stringify(usdtSymbols)}`);
    const tickers = await tickerResponse.json();

    return tickers
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, 100)
        .map(ticker => ticker.symbol);
}

// Analyze selected coins over the date range
async function analyzeData() {
    const selectedCoins = $('#coins').val();
    const startDate = $('#startDate').val();
    const endDate = $('#endDate').val();

    // Input validation
    if (!selectedCoins || selectedCoins.length === 0) {
        alert('Please select at least one coin.');
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

    $('#loading').show();
    $('#results').empty();

    try {
        const results = await analyzeCoins(selectedCoins, startDate, endDate);
        displayResults(results, selectedCoins, getDatesInRange(startDate, endDate));
    } catch (error) {
        console.error('Analysis failed:', error);
        $('#results').html('<div class="alert alert-danger">An error occurred during analysis. Please try again later.</div>');
    } finally {
        $('#loading').hide();
    }
}

// Fetch k-line data from Binance API
async function fetchKlines(coin, interval, date) {
    const startTime = new Date(date + 'T00:00:00Z').getTime();
    const endTime = startTime + 86400000; // 24 hours
    const response = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${coin}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`
    );
    const data = await response.json();
    return data.map(d => ({ open: parseFloat(d[1]), close: parseFloat(d[4]), volume: parseFloat(d[5]) }));
}

// Calculate value area (VAL and VAH) for 80% of volume
function calculateValueArea(klines) {
    const priceVolume = {};
    let totalVolume = 0;

    klines.forEach(k => {
        const price = Math.round(k.close * 100) / 100; // 2 decimal places
        priceVolume[price] = (priceVolume[price] || 0) + k.volume;
        totalVolume += k.volume;
    });

    const sortedPrices = Object.keys(priceVolume).map(Number).sort((a, b) => a - b);
    const poc = sortedPrices.reduce((max, p) => priceVolume[p] > priceVolume[max] ? p : max, sortedPrices[0]);
    let coveredVolume = priceVolume[poc];
    let val = poc, vah = poc;

    while (coveredVolume < 0.8 * totalVolume) {
        const valIdx = sortedPrices.indexOf(val);
        const vahIdx = sortedPrices.indexOf(vah);
        const below = valIdx > 0 ? sortedPrices[valIdx - 1] : null;
        const above = vahIdx < sortedPrices.length - 1 ? sortedPrices[vahIdx + 1] : null;

        if (below && (!above || priceVolume[below] >= (priceVolume[above] || 0))) {
            val = below;
            coveredVolume += priceVolume[below];
        } else if (above) {
            vah = above;
            coveredVolume += priceVolume[above];
        } else {
            break;
        }
    }
    return { val, vah };
}

// Analyze a coin for a single day
async function analyzeCoinForDay(coin, date) {
    const prevDay = new Date(date);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().split('T')[0];

    const prevKlines = await fetchKlines(coin, '1m', prevDayStr);
    const valueArea = calculateValueArea(prevKlines);
    const currentKlines = await fetchKlines(coin, '30m', date);

    if (currentKlines[0].open >= valueArea.val) return null; // Open not below VAL

    for (let i = 1; i < currentKlines.length; i++) {
        if (currentKlines[i-1].close > valueArea.val && currentKlines[i].close > valueArea.val) {
            const buyPrice = currentKlines[i].close;
            const sellPrice = currentKlines[currentKlines.length - 1].close;
            return ((sellPrice - buyPrice) / buyPrice) * 100;
        }
    }
    return null;
}

// Analyze all coins over the date range
async function analyzeCoins(coins, startDate, endDate) {
    const dates = getDatesInRange(startDate, endDate);
    const results = {};

    for (const date of dates) {
        results[date] = {};
        for (const coin of coins) {
            results[date][coin] = await analyzeCoinForDay(coin, date);
            await new Promise(resolve => setTimeout(resolve, 100)); // Rate limit delay
        }
    }
    return results;
}

// Get dates in range
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
function displayResults(results, coins, dates) {
    const table = $('<table class="table table-bordered table-hover"></table>');
    const headerRow = $('<tr><th scope="col">Date</th></tr>');
    coins.forEach(coin => headerRow.append(`<th scope="col">${coin}</th>`));
    table.append(headerRow);

    dates.forEach(date => {
        const row = $(`<tr><td>${date}</td></tr>`);
        coins.forEach(coin => {
            const roi = results[date][coin];
            const cell = $('<td></td>');
            if (roi !== null) {
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
