$(document).ready(function() {
    initCoinSelect();
    $('#analyze').click(analyzeData);
});

// Initialize coin dropdown with search functionality
async function initCoinSelect() {
    try {
        const response = await fetch('https://api.binance.com/api/v3/exchangeInfo');
        if (!response.ok) {
            throw new Error('Failed to fetch exchange info');
        }
        const data = await response.json();

        const usdtSymbols = data.symbols
            .filter(symbol => symbol.quoteAsset === 'USDT' && symbol.status === 'TRADING')
            .map(symbol => ({
                id: symbol.symbol,
                text: symbol.symbol
            }));

        $('#coins').select2({
            data: usdtSymbols,
            placeholder: "Select up to 10 coins (searchable)",
            maximumSelectionLength: 10,
            width: '100%'
        });
    } catch (error) {
        console.error('Error initializing coin select:', error);
        alert('Failed to load coin list. Please try again later.');
    }
}

// Analyze selected coins over the date range
async function analyzeData() {
    const selectedCoins = $('#coins').val();
    const startDate = $('#startDate').val();
    const endDate = $('#endDate').val();

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
        displayChart(results, selectedCoins, getDatesInRange(startDate, endDate));
    } catch (error) {
        console.error('Analysis failed:', error);
        alert('An error occurred during analysis. Please try again later.');
    } finally {
        $('#loading').hide();
    }
}

// Fetch k-line data from Binance API with pagination
async function fetchKlines(coin, interval, date) {
    const startTime = new Date(date + 'T00:00:00Z').getTime();
    const endTime = startTime + 86400000; // 24 hours
    let allKlines = [];
    let lastTime = startTime;

    while (lastTime < endTime) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${coin}&interval=${interval}&startTime=${lastTime}&endTime=${endTime}&limit=1000`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch klines for ${coin} on ${date}: ${response.status}`);
        const data = await response.json();
        if (data.length === 0) break;
        allKlines = allKlines.concat(data.map(d => ({ open: parseFloat(d[1]), close: parseFloat(d[4]), volume: parseFloat(d[5]) })));
        lastTime = data[data.length - 1][0] + 1; // Next start time
        await new Promise(resolve => setTimeout(resolve, 100)); // Delay to avoid rate limit
    }
    return allKlines;
}

// Calculate value area (VAL and VAH) for 80% of volume
function calculateValueArea(klines) {
    if (klines.length === 0) {
        console.warn('No kline data available for value area calculation');
        return { val: null, vah: null };
    }

    const priceVolume = {};
    let totalVolume = 0;

    klines.forEach(k => {
        const price = Math.round(k.close * 100) / 100; // 2 decimal places
        priceVolume[price] = (priceVolume[price] || 0) + k.volume;
        totalVolume += k.volume;
    });

    const sortedPrices = Object.keys(priceVolume).map(Number).sort((a, b) => a - b);
    if (sortedPrices.length === 0) {
        console.warn('No price data available for value area calculation');
        return { val: null, vah: null };
    }

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
    if (valueArea.val === null || valueArea.vah === null) {
        console.warn(`Skipping analysis for ${coin} on ${date} due to insufficient data for value area calculation`);
        return null;
    }

    const currentKlines = await fetchKlines(coin, '30m', date);
    if (currentKlines.length === 0) {
        console.warn(`No kline data available for ${coin} on ${date}`);
        return null;
    }

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

// Display results in a chart
function displayChart(results, coins, dates) {
    const ctx = document.getElementById('roiChart').getContext('2d');
    const datasets = coins.map(coin => {
        const data = dates.map(date => results[date][coin]);
        return {
            label: coin,
            data: data,
            borderColor: getRandomColor(),
            fill: false
        };
    });

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: dates,
            datasets: datasets
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) label += context.parsed.y.toFixed(2) + '%';
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: { display: true, title: { display: true, text: 'Date' } },
                y: { display: true, title: { display: true, text: 'ROI (%)' } }
            }
        }
    });
}

// Helper function to generate random colors
function getRandomColor() {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
}
