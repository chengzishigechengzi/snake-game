const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs'); // Add FS for persistence
const PF = require('pathfinding');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') {
            // For index.html, always check for updates
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Surrogate-Control', 'no-store');
        } else {
            // For other assets (images, etc), cache for 1 day
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
}));

// --- Constants ---
const VERSION = 'v1.1.6';
const GRID_SIZE = 25; // Increase grid size to zoom in (reduce view range)
const TILE_COUNT_X = 100; // Increase map size
const TILE_COUNT_Y = 100; // Increase map size
const TOTAL_TILES = TILE_COUNT_X * TILE_COUNT_Y;
const AUTO_FOOD_LIMIT = 400; // Reduced from 600
const AUTO_FOOD_FLOOR = 300; // Reduced from 400
const TICK_RATE = 30; // Optimized for 30Hz (Smoother)
const TICK_MS = 1000 / TICK_RATE;

// --- State ---
let players = {};
let foodItems = [];
let aiSnakes = []; // Array of AI objects
let aiIdCounter = 0;
// High Score List: {name: string, score: number}[]
let highScores = []; 
const HS_FILE = path.join(__dirname, 'highscores.json');

// Load High Scores
try {
    if (fs.existsSync(HS_FILE)) {
        try {
            const data = fs.readFileSync(HS_FILE, 'utf8');
            if (data.trim().length > 0) {
                highScores = JSON.parse(data);
            }
        } catch(e) {
            console.error("Parse error", e);
            highScores = [];
        }
    }
} catch (err) {
    console.error("Failed to load high scores:", err);
    highScores = [];
}

// Ensure defaults if empty (whether file missing, empty, or corrupt)
if (!highScores || highScores.length === 0) {
    highScores = [
        { name: "神秘高手", score: 500 },
        { name: "贪吃蛇", score: 200 },
        { name: "萌新", score: 50 }
    ];
    // Try to write it back so file exists next time (if persistence allows)
    try {
        fs.writeFileSync(HS_FILE, JSON.stringify(highScores));
    } catch(e) {}
}

function updateHighScores(player) {
    if (player.score <= 0) return;
    
    // Check if qualifies for Top 3
    let qualified = false;
    if (highScores.length < 3) qualified = true;
    else if (player.score > highScores[highScores.length-1].score) qualified = true;
    
    if (qualified) {
        // Add current score
        const existingIndex = highScores.findIndex(h => h.name === player.name);
        
        if (existingIndex !== -1) {
            // Update only if higher
            if (player.score > highScores[existingIndex].score) {
                highScores[existingIndex].score = player.score;
            }
        } else {
            highScores.push({ name: player.name, score: player.score });
        }
        
        // Sort and Trim
        highScores.sort((a, b) => b.score - a.score);
        if (highScores.length > 3) highScores = highScores.slice(0, 3);
        
        // Save to Disk
        try {
            fs.writeFileSync(HS_FILE, JSON.stringify(highScores));
        } catch (err) {
            console.error("Failed to save high scores:", err);
        }

        // Broadcast Update
        io.emit('highscore_update', highScores);
    }
}

// Pathfinding Grid (reused)
const pfGrid = new PF.Grid(TILE_COUNT_X, TILE_COUNT_Y);
const finder = new PF.AStarFinder({
    allowDiagonal: false,
    dontCrossCorners: true
});

// --- Helpers ---
function getRandomPosition() {
    return {
        x: Math.floor(Math.random() * TILE_COUNT_X),
        y: Math.floor(Math.random() * TILE_COUNT_Y)
    };
}

function spawnFood(count = 1, force = false) {
    for (let i = 0; i < count; i++) {
        // Strict limit check: Stop if we hit the ceiling and not forced
        if (!force && foodItems.length >= AUTO_FOOD_LIMIT) break;
        
        let pos;
        let attempts = 0;
        let valid = false;
        
        // Food Types:
        // 0: Normal (Default)
        // 1: Big (1:7 chance)
        // 2: Poison (1:7 chance)
        // Ratios: Normal : Big : Poison = 5 : 1 : 1 (approx 1:7 if we consider total pool)
        // Let's use simple random:
        // rand < 0.14 (~1/7) -> Big
        // rand < 0.28 (~2/7) -> Poison
        // else -> Normal
        
        let type = 0;
        let r = Math.random();
        if (r < 0.20) type = 1; // Big (20%)
        else if (r < 0.40) type = 2; // Poison (20%)
        else type = 0; // Normal (60%)
        
        while (!valid && attempts < 50) {
            pos = getRandomPosition();
            attempts++;
            valid = true;
            // Check Players
            for (let id in players) {
                if (players[id].snake.some(s => s.x === pos.x && s.y === pos.y)) { valid = false; break; }
            }
            // Check AI
            if (valid) {
                for (let ai of aiSnakes) {
                    if (ai.snake.some(s => s.x === pos.x && s.y === pos.y)) { valid = false; break; }
                }
            }
            // Check Food (Prevent Overlap)
            if (valid && foodItems.some(f => f.x === pos.x && f.y === pos.y)) valid = false;
        }
        
        if (valid) {
            foodItems.push({
                x: pos.x,
                y: pos.y,
                type: type
            });
        }
    }
}

function getUniquePlayerColor() {
    let hue;
    let valid = false;
    let attempts = 0;

    while (!valid && attempts < 20) {
        hue = Math.floor(Math.random() * 360);
        attempts++;

        // 1. Avoid Blue (AI Color is roughly 200-260 range)
        // Let's exclude 180 to 270 to be safe
        if (hue >= 180 && hue <= 270) continue;

        // 2. Avoid existing player colors
        let conflict = false;
        for (let id in players) {
            let pColor = players[id].color;
            // Parse hue from existing player color string "hsl(123, 70%, 50%)"
            let match = pColor.match(/hsl\((\d+(\.\d+)?)/);
            if (match) {
                let existingHue = parseFloat(match[1]);
                // Check distance (e.g. 30 degrees)
                let diff = Math.abs(hue - existingHue);
                if (diff < 30 || diff > 330) { // Handle wrap around
                    conflict = true;
                    break;
                }
            }
        }
        
        if (!conflict) valid = true;
    }
    
    // If fails (too many players), fallback to random non-blue
    if (!valid) {
        do {
            hue = Math.floor(Math.random() * 360);
        } while (hue >= 180 && hue <= 270);
    }

    return `hsl(${hue}, 70%, 50%)`;
}

function spawnSpecificFood(x, y, type) {
    // Basic boundary check
    if (x < 0 || x >= TILE_COUNT_X || y < 0 || y >= TILE_COUNT_Y) return;
    
    // Hard cap total food to prevent performance issues
    if (foodItems.length >= 600) {
        // Option 1: Don't spawn
        // return; 
        
        // Option 2: Remove oldest (better for gameplay flow)
        foodItems.shift();
    }
    
    foodItems.push({ x, y, type });
}

// Initial food spawn: Start with 10% density
spawnFood(AUTO_FOOD_FLOOR, true);

// --- AI System ---
class AISnake {
    constructor() {
        this.id = `ai_${aiIdCounter++}`;
        this.reset();
    }

    reset() {
        // Try to find a safe spawn position (not on a player)
        let pos;
        let valid = false;
        let attempts = 0;
        
        while (!valid && attempts < 50) {
            pos = getRandomPosition();
            valid = true;
            // Check Players
            for (let pid in players) {
                if (players[pid].snake.some(s => s.x === pos.x && s.y === pos.y)) { 
                    valid = false; 
                    break; 
                }
            }
            attempts++;
        }
        if (!valid) pos = getRandomPosition(); // Fallback

        this.snake = [pos];
        this.velocity = { x: 0, y: 0 };
        this.score = 5 + Math.floor(Math.random() * 5); // Start with some length
        // Grow snake to initial score
        for(let i=0; i<this.score; i++) this.snake.push({...this.snake[0]});
        
        this.color = '#1E3A8A'; // Dark Blue
        this.isDead = false;
        this.name = '大魔丸';
        this.moveTick = 0;
        this.rageMode = false;
        this.targetPlayerId = null;
        this.path = [];
        this.repathTimer = 0;
        this.speedBoost = false;
        this.boostCooldown = 0;
        this.boostDuration = 0;
        this.spawnSafeTimer = 5000; // 5s safe time on spawn
        
        // Give initial random velocity to prevent being stuck
        const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
        this.velocity = dirs[Math.floor(Math.random()*4)];
    }

    checkSafe(x, y) {
        // Wall
        if (x < 0 || x >= TILE_COUNT_X || y < 0 || y >= TILE_COUNT_Y) return false;
        
        // Self Body
        // Note: tail might move away, but for safety assume static
        if (this.snake.some(s => s.x === x && s.y === y)) return false;
        
        // Other AIs
        for(let other of aiSnakes) {
             if (other === this || other.isDead) continue;
             if (other.snake.some(s => s.x === x && s.y === y)) return false;
        }
        
        // Players
        for (let pid in players) {
            let p = players[pid];
            if (p.isDead) continue;
            
            // Body Check
            if (p.snake.some(s => s.x === x && s.y === y)) {
                 // Head Check
                 if (p.snake[0].x === x && p.snake[0].y === y) {
                     // Safe only if we are bigger/equal (win tie)
                     // But user wants to attack head, so we shouldn't treat it as "wall" if we can win.
                     // checkSafe is for "will I die?"
                     if (this.score >= p.score) return true; // We kill them, safe
                     else return false; // They kill us, unsafe
                 }
                 return false; // Body hit always unsafe
            }
        }
        return true;
    }

    update() {
        if (this.isDead) return;
        
        if (this.spawnSafeTimer > 0) {
            this.spawnSafeTimer -= 1000 / TICK_RATE; // Decrement by tick duration
        }

        // Rage Mode Check: Length > Player 50%
        // Find max player length
        let maxPlayerScore = 0;
        let closestPlayer = null;
        let minDist = Infinity;
        let head = this.snake[0];

        // Find Target
        for (let pid in players) {
            let p = players[pid];
            if (p.isDead || p.invulnerable > 0) continue; // Don't target dead or invulnerable
            
            // Check max score for rage threshold
            if (p.score > maxPlayerScore) maxPlayerScore = p.score;

            // Distance check for targeting
            let d = Math.abs(p.snake[0].x - head.x) + Math.abs(p.snake[0].y - head.y);
            if (d < minDist) {
                minDist = d;
                closestPlayer = p;
            }
        }

        this.rageMode = (this.score > maxPlayerScore * 0.5) && maxPlayerScore > 0;
        
        // AI Logic: Repath periodically
        this.repathTimer--;
        // Repath frequently (every 2 ticks) if active, or if no path
        // This ensures we track the moving player closely
        if (this.repathTimer <= 0 || this.path.length === 0) {
            this.repathTimer = 2; // Very frequent updates
            
            // Clone grid for pathfinding
            let grid = pfGrid.clone();
            
            // Mark obstacles
            // Players
            for (let pid in players) {
                let p = players[pid];
                if (p.isDead) continue;
                p.snake.forEach(s => {
                   if (grid.isInside(s.x, s.y)) grid.setWalkableAt(s.x, s.y, false);
                });
            }
            // Other AIs
            for (let ai of aiSnakes) {
                if (ai === this || ai.isDead) continue;
                ai.snake.forEach(s => {
                    if (grid.isInside(s.x, s.y)) grid.setWalkableAt(s.x, s.y, false);
                });
            }
            // Self body (except head/tail?)
            for(let i=1; i<this.snake.length-1; i++){
                 let s = this.snake[i];
                 if (grid.isInside(s.x, s.y)) grid.setWalkableAt(s.x, s.y, false);
            }

            // Determine Goal
            let goal = null;
            this.speedBoost = false; // Default off

            // Find target player
            // Scoring system: Lower is better
            // Base score = distance
            // Poisoned bonus = -50 (Prioritize poisoned players significantly)
            let targetPlayer = null;
            let bestScore = Infinity;

            for (let pid in players) {
                let p = players[pid];
                if (p.isDead || p.invulnerable > 0) continue;
                
                let dx = Math.abs(p.snake[0].x - head.x);
                let dy = Math.abs(p.snake[0].y - head.y);
                
                // Radius 50
                if (dx <= 50 && dy <= 50) {
                    let dist = dx + dy;
                    let score = dist;
                    
                    // Prioritize Poisoned Players!
                    if (p.poisoned > 0) {
                        score -= 50; // Huge bonus
                    }
                    
                    if (score < bestScore) {
                        bestScore = score;
                        targetPlayer = p;
                    }
                }
            }

            if (targetPlayer) { // Target player
                // Aggressive Targeting Logic
                // 1. Try to intercept/cut off (Predicted Position)
                // 2. If blocked, try to surround (Points around head)
                // 3. If blocked, try direct head (Last resort)
                
                let pVel = targetPlayer.velocity;
                let lead = targetPlayer.poisoned > 0 ? 1 : 3;
                
                // Potential Goals
                let goals = [];
                
                // Priority 1: Prediction
                let predictX = targetPlayer.snake[0].x + pVel.x * lead;
                let predictY = targetPlayer.snake[0].y + pVel.y * lead;
                if (grid.isInside(predictX, predictY)) goals.push({x: predictX, y: predictY});
                
                // Priority 2: Surroundings (Cross pattern)
                const surroundOffsets = [{x:2,y:0}, {x:-2,y:0}, {x:0,y:2}, {x:0,y:-2}];
                surroundOffsets.forEach(offset => {
                    let sx = targetPlayer.snake[0].x + offset.x;
                    let sy = targetPlayer.snake[0].y + offset.y;
                    if (grid.isInside(sx, sy)) goals.push({x: sx, y: sy});
                });
                
                // Priority 3: Direct Head
                goals.push(targetPlayer.snake[0]);

                this.speedBoost = true; // Always boost when hunting
                
                // Try to find path to any goal
                let foundPath = false;
                
                // Make area around target walkable temporarily to allow pathfinding to get "close enough"
                // Even if the exact tile is blocked (e.g. by player body), we want to get next to it.
                // Reset happens next frame anyway.
                let tempWalkable = [];
                let tHead = targetPlayer.snake[0];
                for(let dx=-2; dx<=2; dx++) {
                    for(let dy=-2; dy<=2; dy++) {
                        let tx = tHead.x + dx;
                        let ty = tHead.y + dy;
                        if(grid.isInside(tx, ty) && !grid.isWalkableAt(tx, ty)) {
                            grid.setWalkableAt(tx, ty, true);
                            tempWalkable.push({x:tx, y:ty});
                        }
                    }
                }
                
                for (let g of goals) {
                    try {
                        // Ensure start is walkable (sometimes own head is marked unwalkable)
                        grid.setWalkableAt(head.x, head.y, true);
                        grid.setWalkableAt(g.x, g.y, true);
                        
                        let path = finder.findPath(head.x, head.y, g.x, g.y, grid);
                        if (path && path.length > 1) {
                            this.path = path.slice(1);
                            foundPath = true;
                            break;
                        }
                    } catch(e) {}
                }
                
                // Fallback: If no path found, just try to move closer in Euclidean distance (Greedy)
                // This forces them to "circle" or "press" even if blocked
                if (!foundPath) {
                    let bestDir = null;
                    let minD = Infinity;
                    const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
                    
                    dirs.forEach(d => {
                        // Must be safe immediate move
                        if (this.checkSafe(head.x + d.x, head.y + d.y)) {
                            let dist = Math.abs((head.x + d.x) - tHead.x) + Math.abs((head.y + d.y) - tHead.y);
                            if (dist < minD) {
                                minD = dist;
                                bestDir = d;
                            }
                        }
                    });
                    
                    if (bestDir) {
                        this.path = [ {x: head.x + bestDir.x, y: head.y + bestDir.y} ];
                    }
                }

            } else {
                // Find closest food (Avoid Poison!)
                let minFoodDist = Infinity;
                let closestFood = null;
                for (let f of foodItems) {
                    if (f.type === 2) continue; // AI avoids poison!
                    let d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
                    if (d < minFoodDist) {
                        minFoodDist = d;
                        closestFood = f;
                    }
                }
                goal = closestFood;
            }

            if (goal && grid.isInside(head.x, head.y) && grid.isInside(goal.x, goal.y)) {
                 // Logic moved inside targetPlayer block for better handling
                 // But we still need this for Food targeting
                 if (!targetPlayer) {
                     grid.setWalkableAt(head.x, head.y, true);
                     grid.setWalkableAt(goal.x, goal.y, true);
                     try {
                        let path = finder.findPath(head.x, head.y, goal.x, goal.y, grid);
                        if (path && path.length > 1) {
                            this.path = path.slice(1);
                        }
                     } catch(e) {}
                 }
            }
        }

        // Set velocity from path
        let nextMove = null;
        if (this.path.length > 0) {
            let next = this.path.shift(); // Get next step
            // Simple direction
            if (next.x > head.x) nextMove = {x:1, y:0};
            else if (next.x < head.x) nextMove = {x:-1, y:0};
            else if (next.y > head.y) nextMove = {x:0, y:1};
            else if (next.y < head.y) nextMove = {x:0, y:-1};
        } else {
            // Random wander
            let chance = (this.velocity.x === 0 && this.velocity.y === 0) ? 0.5 : 0.1;
            if (Math.random() < chance) {
                const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
                nextMove = dirs[Math.floor(Math.random()*4)];
            }
        }
        
        // --- Active Avoidance Logic ---
        // 1. Check if intended move is safe
        let isIntendedSafe = false;
        if (nextMove) {
            isIntendedSafe = this.checkSafe(head.x + nextMove.x, head.y + nextMove.y);
        }

        // 2. If intended move is unsafe or null, try current velocity
        if (!isIntendedSafe) {
             // Try current velocity
             if (this.velocity.x !== 0 || this.velocity.y !== 0) {
                 if (this.checkSafe(head.x + this.velocity.x, head.y + this.velocity.y)) {
                     nextMove = this.velocity;
                     isIntendedSafe = true;
                 }
             }
        }

        // 3. If still unsafe, Emergency Scan! Find ANY safe direction
        if (!isIntendedSafe) {
            const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
            // Shuffle dirs to avoid bias? Or just iterate.
            // Filter out 180 degree turn (suicide)
            let safeDirs = dirs.filter(d => {
                // Don't reverse
                if (d.x === -this.velocity.x && d.y === -this.velocity.y) return false;
                return this.checkSafe(head.x + d.x, head.y + d.y);
            });
            
            if (safeDirs.length > 0) {
                // Pick random safe dir
                nextMove = safeDirs[Math.floor(Math.random() * safeDirs.length)];
            } else {
                // No safe move? We are trapped. Keep going and die with dignity.
                nextMove = this.velocity;
            }
        }
        
        // Apply
        if (nextMove) this.velocity = nextMove;
        
        // Speed Logic
        // Reverted to 1.5 threshold for slower speed (20% slower than boosted state)
        
        let threshold = 5.0; // Slow speed (Target 6 moves/sec)
        if (this.rageMode) threshold = 4.0; 
        if (this.speedBoost) threshold = 2.5;

        this.moveTick++;
        if (this.moveTick >= threshold) {
            this.moveTick -= threshold; // Fix: Subtract to keep decimal precision
            this.move();
        }
    }

    move() {
        let head = { x: this.snake[0].x + this.velocity.x, y: this.snake[0].y + this.velocity.y };
        
        // Walls
        if (head.x < 0 || head.x >= TILE_COUNT_X || head.y < 0 || head.y >= TILE_COUNT_Y) {
            this.die();
            return;
        }

        // Check Collisions (Players & AI)
        // ... (Similar to Player logic, simplified for brevity)
        // If hits player -> Player dies (if not invulnerable)
        // If hits self -> Die
        
        // Self
        if (this.snake.some(s => s.x === head.x && s.y === head.y)) { this.die(); return; }
        
        // AI
        for(let other of aiSnakes) {
            if (other === this || other.isDead) continue;
            if (other.snake.some(s => s.x === head.x && s.y === head.y)) { this.die(); return; }
        }

        // Players
        for (let pid in players) {
            let p = players[pid];
            if (p.isDead) continue;
            // Head hit Player Body
            if (p.snake.some(s => s.x === head.x && s.y === head.y)) {
                // If Safe, Ghost Mode -> Pass through
                if (this.spawnSafeTimer > 0) return;

                this.die(p); // Player killed AI
                return;
            }
            // Head hit Player Head
            if (p.snake[0].x === head.x && p.snake[0].y === head.y) {
                 if (this.score >= p.score) {
                     // AI wins or tie
                     // Check safe timer
                     if (this.spawnSafeTimer > 0) {
                         // Pass through / Ignore if in safe mode
                         return;
                     }
                     if (p.invulnerable <= 0) {
                         p.die();
                     }
                 } else {
                     // Player wins
                     this.die(p);
                     return;
                 }
            }
        }

        this.snake.unshift(head);
        
        // Food
        let ate = false;
        for (let i = 0; i < foodItems.length; i++) {
            if (foodItems[i].x === head.x && foodItems[i].y === head.y) {
                if (foodItems[i].type === 2) {
                    // AI ate poison!
                    this.die();
                    foodItems.splice(i, 1);
                    spawnFood(1);
                    return; // Stop processing move
                }
                this.score += 10;
                foodItems.splice(i, 1);
                ate = true;
                spawnFood(1);
                break;
            }
        }
        
        // Length control
        // AI does NOT grow (Fixed length 20)
        let targetLen = 20;
        while (this.snake.length > targetLen) {
            this.snake.pop();
        }
        while (this.snake.length < targetLen) {
            // Should not happen often, but if it does, duplicate tail
            this.snake.push({...this.snake[this.snake.length-1]});
        }
    }
    
    die(killer = null) {
        this.isDead = true;
        // Drop food: 50% of body segments become food, NO LIMIT
          this.snake.forEach((s, i) => {
               if (i % 2 === 0) {
                   let type = 0;
                   let r = Math.random();
                   if (r < 0.2) type = 1; // Big (20%)
                   else if (r < 0.3) type = 2; // Poison (10%)
                   else type = 0; // Normal (70%)
                   spawnSpecificFood(s.x, s.y, type);
               }
          });
        
        // Killer Reward
        if (killer) {
            killer.addKillReward();
            io.emit('kill_event', { killer: killer.name, victim: this.name });
        }

        // Respawn later
        setTimeout(() => {
            this.reset();
        }, 3000); // 3s Respawn (Very fast for action)
    }
}

// Initialize AIs
for(let i=0; i<20; i++) aiSnakes.push(new AISnake());


// --- Player Logic ---
function initPlayer(socket) {
    players[socket.id] = {
        id: socket.id,
        snake: [getRandomPosition()],
        velocity: { x: 0, y: 0 },
        nextVelocity: { x: 0, y: 0 },
        score: 0,
        color: getUniquePlayerColor(),
        name: `Player ${Object.keys(players).length + 1}`,
        isDead: false,
        speedBoost: false,
        boostCooldown: 0,
        boostDuration: 0,
        invulnerable: 3000, // 3s invulnerability on spawn
        safeTimer: 5000, // 5s safe from AI on spawn
        magnet: 0, // Magnet timer
        moveTick: 0,
        
        // Methods attached to object for convenience? 
        // No, standard JS object, functions separate or prototype if class.
        // Let's stick to functional for now to avoid major refactor.
    };
    
    // Attach helper to object (monkey patch style for simplicity in this file)
    players[socket.id].die = function() {
        if (this.isDead) return; // Prevent double death
        
        // Update High Score on Death
        updateHighScores(this);
        
        // Force sync High Scores to this player
        socket.emit('highscore_update', highScores);
        // Explicit death event for client UI
        socket.emit('die', { score: this.score });
        
        this.isDead = true;
        this.velocity = { x: 0, y: 0 };
        this.nextVelocity = { x: 0, y: 0 };
        
        io.emit('play_sound', { id: this.id, type: 'die' });
        
        // Drop food where body was, NO LIMIT
        // Drop rate: 50% of body segments become food
        this.snake.forEach((s, index) => {
            if (index % 2 === 0) {
                // Randomize food type
                let type = 0; // Normal
                let r = Math.random();
                if (r < 0.2) type = 1; // Big (20%)
                else if (r < 0.3) type = 2; // Poison (10% chance to drop on death!)
                else type = 0; // Normal (70%)
                
                spawnSpecificFood(s.x, s.y, type);
            }
        });
    };
    
    players[socket.id].respawn = function(name) {
        if (name) this.name = name;
        this.snake = [];
        this.score = 0;
        this.isDead = false;
        this.invulnerable = 3000;
        this.poisoned = 0;
        this.magnet = 0;
        this.speedBoost = false;
        this.boostCooldown = 0;
        this.velocity = {x:0,y:0};
        this.nextVelocity = {x:0,y:0};
        this.moveTick = 0; // RESET MOVE TICK!
        
        let startPos = getRandomPosition();
        this.snake = [startPos];
    };

    players[socket.id].addKillReward = function() {
        // +30% Length
        let currentLen = 1 + Math.floor(this.score / 10);
        let added = Math.floor(currentLen * 0.3);
        this.score += added * 10;
        
        // Sync Magnet and Invulnerability to 5s (5000ms)
        this.invulnerable = 5000;
        this.magnet = 5000;
        
        io.emit('play_sound', { id: this.id, type: 'kill_ai' });
    };
}


io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    initPlayer(socket);

    socket.emit('init', {
        id: socket.id,
        version: VERSION,
        gridSize: GRID_SIZE,
        tileCountX: TILE_COUNT_X,
        tileCountY: TILE_COUNT_Y,
        highScores: highScores // Send initial high scores
    });

    socket.on('input', (data) => {
        const p = players[socket.id];
        if (!p || p.isDead) return;
        
        // Prevent 180 (standard logic)
        if ((data.x === 1 && p.velocity.x === -1) ||
            (data.x === -1 && p.velocity.x === 1) ||
            (data.y === 1 && p.velocity.y === -1) ||
            (data.y === -1 && p.velocity.y === 1)) return;
            
        p.nextVelocity = data;
    });

    socket.on('boost', (active) => {
        const p = players[socket.id];
        if (!p || p.isDead) return;
        
        // Poison disables boost
        if (p.poisoned > 0) return;

        if (active && p.boostCooldown <= 0) {
            p.speedBoost = true;
            p.boostDuration = 50; 
            io.emit('play_sound', { id: p.id, type: 'boost' });
        } else if (!active) {
            p.speedBoost = false;
        }
    });
    
    socket.on('respawn', (name) => {
        // Sanitize Name (Basic)
        if (name) name = name.replace(/</g, "&lt;").replace(/>/g, "&gt;").substring(0, 15);
        const p = players[socket.id];
        if (p) p.respawn(name);
    });
    
    socket.on('get_highscores', () => {
        socket.emit('highscore_update', highScores);
    });

    // Ping/Pong for latency check
    socket.on('ping_check', (clientTime) => {
        socket.emit('pong_check', clientTime);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// Game Loop
let lastTime = Date.now();
setInterval(() => {
    let now = Date.now();
    let dt = now - lastTime;
    lastTime = now;

    // 1. Update AI
    aiSnakes.forEach(ai => ai.update());

    // 2. Update Players
    let sortedPlayers = Object.values(players).sort((a,b) => b.score - a.score);
    let topPlayerId = sortedPlayers.length > 0 ? sortedPlayers[0].id : null;

    for (let id in players) {
        let p = players[id];
        if (p.isDead) continue;
        
        // Timers
        if (p.invulnerable > 0) p.invulnerable -= dt;
        if (p.safeTimer > 0) p.safeTimer -= dt;
        if (p.magnet > 0) p.magnet -= dt;
        if (p.poisoned > 0) p.poisoned -= dt; // Make sure this line exists
        if (p.boostCooldown > 0) p.boostCooldown--;
        
        // Boost Logic
        if (p.speedBoost) {
            if (p.boostDuration > 0) p.boostDuration--;
            else { p.speedBoost = false; p.boostCooldown = 40; } // 40 ticks = 2s
        }

        // Magnet Logic: Pull food
        if (p.magnet > 0) {
            let head = p.snake[0];
            foodItems.forEach(f => {
                // Don't attract Poison (Type 2) - STRICT CHECK
                if (f.type === 2) return;

                let dx = head.x - f.x;
                let dy = head.y - f.y;
                let dist = Math.abs(dx) + Math.abs(dy);
                if (dist < 10) { // Range
                    // Move food towards head
                    // BUT: Ensure we don't accidentally pull it INTO a poison apple (unlikely but safe to check?)
                    // For now, just move it.
                    if (dx > 0) f.x++; else if (dx < 0) f.x--;
                    if (dy > 0) f.y++; else if (dy < 0) f.y--;
                }
            });
        }

        // Move Logic
        if (!p.moveTick) p.moveTick = 0;
        p.moveTick++;
        
        // Base Speed 
        let threshold = 3.0; 
        if (p.speedBoost) threshold = 1.5; 
        
        // Poison Effect: Slow down significantly
        if (p.poisoned > 0) {
            threshold = 9.0; 
        }
        
        if (p.moveTick >= threshold) {
            p.moveTick -= threshold;
            if (p.nextVelocity.x !== 0 || p.nextVelocity.y !== 0) p.velocity = p.nextVelocity;
            if (p.velocity.x === 0 && p.velocity.y === 0) continue;

            let head = { x: p.snake[0].x + p.velocity.x, y: p.snake[0].y + p.velocity.y };
            
            // Wall Collision
            if (head.x < 0 || head.x >= TILE_COUNT_X || head.y < 0 || head.y >= TILE_COUNT_Y) {
                if (p.invulnerable <= 0) p.die();
                continue;
            }

            // Body/Other Player Collision
            let collision = false;
            let killer = null;
            if (p.invulnerable <= 0) {
                // Self (Relaxed to 0.8)
                if (p.snake.some((s, idx) => idx > 0 && Math.abs(s.x - head.x) < 0.8 && Math.abs(s.y - head.y) < 0.8)) {
                    collision = true;
                }
                
                // Others (Players)
                if (!collision) {
                    for (let otherId in players) {
                        let other = players[otherId];
                        if (other.id === p.id || other.isDead) continue;
                        
                        // Head to Head (Relaxed to 0.8)
                        if (Math.abs(other.snake[0].x - head.x) < 0.8 && Math.abs(other.snake[0].y - head.y) < 0.8) {
                            if (p.score < other.score) {
                                collision = true;
                                killer = other;
                            } else if (p.score > other.score) {
                                other.die(); // We kill them
                            } else {
                                collision = true; // Tie, we both die
                                other.die();
                            }
                            break;
                        }
                        
                        // Head to Body (Relaxed to 0.8)
                        if (other.snake.some(s => Math.abs(s.x - head.x) < 0.8 && Math.abs(s.y - head.y) < 0.8)) {
                            collision = true;
                            killer = other;
                            break;
                        }
                    }
                }
                
                // AI
                if (!collision) {
                    for (let ai of aiSnakes) {
                        if (ai.isDead || ai.spawnSafeTimer > 0) continue;
                        
                        // Head to Head AI
                        if (Math.abs(ai.snake[0].x - head.x) < 0.5 && Math.abs(ai.snake[0].y - head.y) < 0.5) {
                            if (p.score < ai.score) {
                                collision = true;
                            } else if (p.score > ai.score) {
                                ai.die(p);
                            } else {
                                collision = true;
                                ai.die(p);
                            }
                            break;
                        }

                        // Use a slightly forgiving hitbox (0.8 instead of exact match)
                        // This prevents dying when just "grazing" a corner
                        if (ai.snake.some(s => Math.abs(s.x - head.x) < 0.8 && Math.abs(s.y - head.y) < 0.8)) {
                            collision = true;
                            break;
                        }
                    }
                }
            }

            if (collision) {
                p.die();
                if (killer) killer.addKillReward();
                continue;
            }

            p.snake.unshift(head);

            // Eat Food
            let ate = false;
            for (let i = 0; i < foodItems.length; i++) {
                if (foodItems[i].x === head.x && foodItems[i].y === head.y) {
                    let f = foodItems[i];
                    
                    if (f.type === 1) { // Big Food
                        p.score += 50;
                        io.emit('play_sound', { id: p.id, type: 'eat_big' });
                    } else if (f.type === 2) { // Poison Food
                        p.score += 10;
                        p.poisoned = 3000; // 3s Poison
                        p.speedBoost = false; // Disable current boost
                        io.emit('play_sound', { id: p.id, type: 'poison' });
                        // Notify client to show toast
                        io.to(p.id).emit('show_toast', { message: '你中毒了', duration: 1000 });
                    } else { // Normal
                        p.score += 10;
                        io.emit('play_sound', { id: p.id, type: 'eat' });
                    }
                    
                    foodItems.splice(i, 1);
                    ate = true;
                    // Auto-refill ONLY if we fall below the 10% floor
                    if (foodItems.length < AUTO_FOOD_FLOOR) {
                        spawnFood(1);
                    }
                    break;
                }
            }
            
            // Maintain length
            let targetLen = 1 + Math.floor(p.score / 10);
            while (p.snake.length > targetLen) p.snake.pop();
        }
    }

    // --- Broadcast Optimized State (AOI) ---
    const VIEW_DISTANCE = 30; // Tiles visible around head

    for (let id in players) {
        const p = players[id];
        // Even dead players need the state to see the game over screen or spectate
        
        // If dead, we use their last known head position for AOI (Area of Interest)
        // If they just connected and haven't moved, use random pos or 0,0
        const head = (p.snake && p.snake.length > 0) ? p.snake[0] : {x: TILE_COUNT_X/2, y: TILE_COUNT_Y/2};
        
        // Filter entities within view distance
        const visiblePlayers = {};
        for (let otherId in players) {
            const other = players[otherId];
            if (other.isDead && other.id !== p.id) continue; // Don't show OTHER dead players, but show self if dead
            
            const otherHead = (other.snake && other.snake.length > 0) ? other.snake[0] : null;
            if (!otherHead) continue;

            if (Math.abs(otherHead.x - head.x) < VIEW_DISTANCE && Math.abs(otherHead.y - head.y) < VIEW_DISTANCE) {
                visiblePlayers[otherId] = {
                    id: other.id,
                    name: other.name,
                    snake: other.snake,
                    color: other.color,
                    score: other.score,
                    isDead: other.isDead,
                    invulnerable: other.invulnerable,
                    poisoned: other.poisoned,
                    magnet: other.magnet,
                    speedBoost: other.speedBoost,
                    velocity: other.velocity
                };
            }
        }

        const visibleFood = foodItems.filter(f => 
            Math.abs(f.x - head.x) < VIEW_DISTANCE && Math.abs(f.y - head.y) < VIEW_DISTANCE
        );

        const visibleAI = aiSnakes.filter(ai => {
            if (ai.isDead) return false;
            const aiHead = ai.snake[0];
            return Math.abs(aiHead.x - head.x) < VIEW_DISTANCE && Math.abs(aiHead.y - head.y) < VIEW_DISTANCE;
        }).map(ai => ({
            id: ai.id,
            snake: ai.snake,
            isDead: ai.isDead,
            rageMode: ai.rageMode,
            color: ai.color,
            name: ai.name,
            velocity: ai.velocity,
            spawnSafe: ai.spawnSafeTimer > 0
        }));

        io.to(id).emit('state', {
            players: visiblePlayers,
            food: visibleFood,
            aiSnakes: visibleAI,
            topPlayerId: topPlayerId
        });
    }

}, TICK_MS);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (${VERSION})`);
});
