// Fetch available coins from Binance and populate the dropdown
async function fetchCoins() {
    try {
        const response = await fetch('https://api.binance.com/api/v3/exchangeInfo');
        const data = await response.json();
        const coins = data.symbols
            .filter(symbol => symbol.quoteAsset === 'USDT')
            .map(symbol => symbol.symbol);
        const select = document.getElementById('coins');
        coins.forEach(coin => {
            const option = document.createElement('option');
            option.value = coin;
            option.text = coin;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error fetching coins:', error);
        alert('Failed to load coin list. Please try again later.');
    }
}

fetchCoins();

// Fetch k-line data from Binance API
async function fetchKlines(coin, interval, date) {
    const startTime = new Date(date).getTime();
    const endTime = startTime + 86400000; // 24 hours in milliseconds
    try {
        const response = await fetch(
            `https://api.binance.com/api/v3/klines?symbol=${coin}&interval=${interval}&startTime=${startTime}&endTime=${endTime}`
        );
        const data = await response.json();
        return data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
        }));
    } catch (error) {
        console.error(`Error fetching klines for ${coin} on ${date}:`, error);
        return null;
    }
}

// Calculate the value area (VAL and VAH) from 1-minute klines
async function calculateValueArea(coin, date) {
    const klines = await fetchKlines(coin, '1m', date);
    if (!klines) return null;

    const priceVolume = {};
    let totalVolume = 0;
    klines.forEach(k => {
        const price = k.close.toFixed(8); // Use string to avoid floating-point issues
        const volume = k.volume;
        if (!priceVolume[price]) priceVolume[price] = 0;
        priceVolume[price] += volume;
        totalVolume += volume;
    });

    const sortedPrices = Object.keys(priceVolume)
        .map(p => parseFloat(p))
        .sort((a, b) => a - b);
    const poc = sortedPrices.reduce((a, b) => priceVolume[a] > priceVolume[b] ? a : b);
    let coveredVolume = priceVolume[poc];
    let val = poc;
    let vah = poc;

    while (coveredVolume < 0.7 * totalVolume) {
        const valIdx = sortedPrices.indexOf(val);
        const vahIdx = sortedPrices.indexOf(vah);
        const below = valIdx > 0 ? sortedPrices[valIdx - 1] : null;
        const above = vahIdx < sortedPrices.length - 1 ? sortedPrices[vahIdx + 1] : null;

        if (below && above) {
            if (priceVolume[below] > priceVolume[above]) {
                val = below;
                coveredVolume += priceVolume[below];
            } else {
                vah = above;
                coveredVolume += priceVolume[above];
            }
        } else if (below) {
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

// Calculate ROI based on the 80% rule
function calculateROI(dayData, valueArea) {
    if (!dayData || dayData.length < 2 || !valueArea) return null;
    const openPrice = dayData[0].open;
    const lastTwoBars = dayData.slice(-2);

    if (
        openPrice < valueArea.val &&
        lastTwoBars.every(bar => bar.close >= valueArea.val && bar.close <= valueArea.vah)
    ) {
        const buyPrice = lastTwoBars[0].close;
        const sellPrice = dayData[dayData.length - 1].close;
        return ((sellPrice - buyPrice) / buyPrice) * 100;
    }
    return null;
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

// Get the previous day's date
function getPreviousDay(date) {
    const prev = new Date(date);
    prev.setDate(prev.getDate() - 1);
    return prev.toISOString().split('T')[0];
}

// Analyze coins over the date range
async function analyzeCoins(coins, startDate, endDate) {
    const results = {};
    const dates = getDatesInRange(startDate, endDate);

    for (const coin of coins) {
        results[coin] = {};
        for (const date of dates) {
            const prevDay = getPreviousDay(date);
            const valueArea = await calculateValueArea(coin, prevDay);
            const dayData = await fetchKlines(coin, '30m', date);
            const roi = calculateROI(dayData, valueArea);
            results[coin][date] = roi;
            // Add delay to respect API rate limits
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    return results;
}

// Display results in a table
function displayResults(results) {
    const table = document.createElement('table');
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = '<th>Date</th>' + Object.keys(results).map(coin => `<th>${coin}</th>`).join('');
    table.appendChild(headerRow);

    const dates = Object.keys(results[Object.keys(results)[0]]);
    dates.forEach(date => {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${date}</td>`;
        Object.keys(results).forEach(coin => {
            const roi = results[coin][date];
            const cell = document.createElement('td');
            if (roi !== null) {
                cell.textContent = roi.toFixed(2) + '%';
                if (roi > 3) cell.className = 'green';
                else if (roi > 0) cell.className = 'yellow';
                else cell.className = 'red';
            } else {
                cell.textContent = '-';
            }
            row.appendChild(cell);
        });
        table.appendChild(row);
    });

    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = '';
    resultsDiv.appendChild(table);
}

// Handle the analyze button click
document.getElementById('analyze').addEventListener('click', async () => {
    const selectedCoins = Array.from(document.getElementById('coins').selectedOptions).map(option => option.value);
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;

    if (selectedCoins.length > 10) {
        alert('Please select up to 10 coins.');
        return;
    }
    if (!startDate || !endDate) {
        alert('Please select start and end dates.');
        return;
    }

    document.getElementById('results').innerHTML = 'Analyzing... This may take a moment.';
    try {
        const results = await analyzeCoins(selectedCoins, startDate, endDate);
        displayResults(results);
    } catch (error) {
        console.error('Analysis failed:', error);
        document.getElementById('results').innerHTML = 'An error occurred during analysis. Please try again.';
    }
});
