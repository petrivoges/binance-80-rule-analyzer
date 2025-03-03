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
        displayTable(results, selectedCoins, getDatesInRange(startDate, endDate));
    } catch (error) {
        console.error('Analysis failed:', error);
        alert('An error occurred during analysis. Please try again later.');
    } finally {
        $('#loading').hide();
    }
}

// Fetch k-line data from Binance API with timestamps
async function fetchKlines(coin, interval, date) {
    const startTime = new Date(date + 'T00:00:00Z').getTime();
    const endTime = startTime + 86400000; // 24 hours
    let allKlines = [];
    let lastTime = startTime;

    while (true) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${coin}&interval=${interval}&startTime=${lastTime}&endTime=${endTime}&limit=1000`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch klines for ${coin} on ${date}: ${response.status}`);
        const data = await response.json();
        if (data.length === 0) break;
        allKlines = allKlines.concat(data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5]),
            openTime: d[0], // milliseconds
            closeTime: d[6] // milliseconds
        })));
        lastTime = data[data.length - 1][6] + 1; // Next start time (close time + 1ms)
        await new Promise(r => setTimeout(r, 200)); // Delay to avoid rate limits
    }
    return allKlines;
}

// Calculate value area (VAL and VAH) for 70% of volume
function calculateValueArea(klines) {
    if (klines.length === 0) return { val: null, vah: null };

    const priceVolume = {};
    let totalVolume = 0;

    klines.forEach(k => {
        const price = Math.round(k.close * 100) / 100; // 2 decimal places
        priceVolume[price] = (priceVolume[price] || 0) + k.volume;
        totalVolume += k.volume;
    });

    const sortedPrices = Object.keys(priceVolume).map(Number).sort((a, b) => a - b);
    if (sortedPrices.length === 0 || totalVolume === 0) return { val: null, vah: null };

    const poc = sortedPrices.reduce((max, p) => priceVolume[p] > priceVolume[max] ? p : max, sortedPrices[0]);
    let coveredVolume = priceVolume[poc];
    let val = poc, vah = poc;

    while (coveredVolume < 0.7 * totalVolume) {
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
        return {
            prevVal: null,
            prevVah: null,
            tradeTriggered: false,
            entryPrice: null,
            entryPriceTime: null,
            proposedProfitPrice: null,
            pppTime: null,
            highestPrice: null,
            diff: null
        };
    }

    const currentKlines = await fetchKlines(coin, '30m', date);
    if (currentKlines.length === 0) {
        return {
            prevVal: valueArea.val,
            prevVah: valueArea.vah,
            tradeTriggered: false,
            entryPrice: null,
            entryPriceTime: null,
            proposedProfitPrice: null,
            pppTime: null,
            highestPrice: null,
            diff: null
        };
    }

    const highestPrice = Math.max(...currentKlines.map(k => k.high));
    const openPrice = currentKlines[0].open;
    let tradeTriggered = false;
    let entryPrice = null;
    let entryPriceTime = null;
    let proposedProfitPrice = null;
    let pppTime = null;
    let diff = null;

    if (openPrice < valueArea.val) {
        for (let i = 1; i < currentKlines.length; i++) {
            if (currentKlines[i-1].close <= valueArea.val && currentKlines[i].close > valueArea.val) {
                tradeTriggered = true;
                entryPrice = currentKlines[i].close;
                entryPriceTime = currentKlines[i].closeTime;
                proposedProfitPrice = entryPrice * 1.03;
                for (let j = i; j < currentKlines.length; j++) {
                    if (currentKlines[j].high >= proposedProfitPrice) {
                        pppTime = currentKlines[j].openTime;
                        break;
                    }
                }
                diff = highestPrice - entryPrice;
                break;
            }
        }
    } else if (openPrice > valueArea.vah) {
        for (let i = 1; i < currentKlines.length; i++) {
            if (currentKlines[i-1].close >= valueArea.vah && currentKlines[i].close < valueArea.vah) {
                tradeTriggered = true;
                entryPrice = currentKlines[i].close;
                entryPriceTime = currentKlines[i].closeTime;
                proposedProfitPrice = entryPrice * 1.03;
                for (let j = i; j < currentKlines.length; j++) {
                    if (currentKlines[j].high >= proposedProfitPrice) {
                        pppTime = currentKlines[j].openTime;
                        break;
                    }
                }
                diff = highestPrice - entryPrice;
                break;
            }
        }
    }

    return {
        prevVal: valueArea.val,
        prevVah: valueArea.vah,
        tradeTriggered: tradeTriggered,
        entryPrice: entryPrice,
        entryPriceTime: entryPriceTime,
        proposedProfitPrice: proposedProfitPrice,
        pppTime: pppTime,
        highestPrice: highestPrice,
        diff: diff
    };
}

// Analyze all coins over the date range
async function analyzeCoins(coins, startDate, endDate) {
    const dates = getDatesInRange(startDate, endDate);
    const results = {};

    for (const date of dates) {
        results[date] = {};
        for (const coin of coins) {
            results[date][coin] = await analyzeCoinForDay(coin, date);
            await new Promise(r => setTimeout(r, 200)); // Delay to avoid rate limits
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

// Format timestamp to GMT+2
function formatTime(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    date.setHours(date.getHours() + 2); // Adjust to GMT+2
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Display results in a table
function displayTable(results, coins, dates) {
    const resultsDiv = $('#results');
    resultsDiv.empty();

    coins.forEach(coin => {
        const tableHtml = `
            <div class="coin-section">
                <h3>${coin}</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Previous Day VAL</th>
                            <th>Previous Day VAH</th>
                            <th>Trade Triggered</th>
                            <th>Entry Price</th>
                            <th>Entry Price Time</th>
                            <th>Proposed Profit Price</th>
                            <th>PPP Time</th>
                            <th>Highest Price</th>
                            <th>Diff</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dates.map(date => {
                            const data = results[date][coin];
                            const entryPriceTime = formatTime(data.entryPriceTime);
                            const pppTime = formatTime(data.pppTime);
                            const diffClass = data.diff > 0 ? 'diff-positive' : data.diff < 0 ? 'diff-negative' : '';
                            const diffDisplay = data.diff !== null ? `<span class="${diffClass}">${data.diff.toFixed(2)}</span>` : '-';
                            return `
                                <tr>
                                    <td>${date}</td>
                                    <td>${data.prevVal ? data.prevVal.toFixed(2) : 'N/A'}</td>
                                    <td>${data.prevVah ? data.prevVah.toFixed(2) : 'N/A'}</td>
                                    <td>${data.tradeTriggered ? 'Yes' : 'No'}</td>
                                    <td>${data.entryPrice ? data.entryPrice.toFixed(2) : '-'}</td>
                                    <td>${entryPriceTime}</td>
                                    <td>${data.proposedProfitPrice ? data.proposedProfitPrice.toFixed(2) : '-'}</td>
                                    <td>${pppTime}</td>
                                    <td>${data.highestPrice ? data.highestPrice.toFixed(2) : '-'}</td>
                                    <td>${diffDisplay}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
        resultsDiv.append(tableHtml);
    });
}