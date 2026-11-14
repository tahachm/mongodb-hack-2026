# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Generates the shared mock product catalog and merchant registry for the ACP merchant mock.

Produces exactly 10,000 unique items across 10 categories, split across 5 merchants with
partial, independent overlap (never a clean per-category partition): for every category,
each eligible merchant independently "rolls" whether it carries a given item, so categories
sold by more than one merchant end up with items exclusive to each merchant AND items shared
by both/all. An item that no eligible merchant rolled for falls back to the merchant with the
highest base probability for that category, so every item has >=1 merchant.

Output is a single catalog.json tagged with `merchantIds` per item (not five separate files),
so running N merchant server instances against the same file and filtering by MERCHANT_ID at
startup is how multiple merchants stay in sync with one source of truth.

Deterministic: every random draw is seeded from a stable SHA-256 hash of (seed, category,
subcategory, index) -- never Python's randomized string hashing -- so re-running this script
reproduces byte-identical output.

Usage: uv run generate_catalog.py
Writes: ../src/main/resources/catalog.json
        ../src/main/resources/merchants.json
"""

import hashlib
import itertools
import json
import random
from collections import Counter, defaultdict
from pathlib import Path

RNG_SEED = 20261114

GROCERY_BRANDS = ["Golden Valley", "Heritage Farms", "CrispCo", "Pure Cascade", "Sunrise Fields",
                  "Harvest Table", "Northgate", "BlueRiver", "CountryMill", "Orchard Lane",
                  "PrimeCut", "Good Earth Organics", "Kettle & Co", "FreshPoint"]
CLOTHING_BRANDS = ["Thread Barn", "Urban Loom", "Northbrook", "Crestline", "Maple & Co",
                    "Harborview", "Rustic Trail", "Alpine Knit", "Driftwood", "Statewear"]
TOILETRY_BRANDS = ["PureGlow", "MintWave", "SilkRoot", "DermaCare", "FreshGuard", "CleanSlate",
                    "AquaPure", "VitalTouch", "GentleSkin", "ShineWell"]
ELECTRONICS_BRANDS = ["Voltrix", "Nexiq", "Pixelon", "Sonara", "ByteForge", "Quantrix",
                       "Circuit9", "Zenlink", "Novacore", "Streamix"]
HOME_BRANDS = ["HearthStone", "CozyNest", "Kindred Home", "Driftwood Living", "Maple Haus",
               "UrbanLoft", "PureLiving", "Homestead Co", "Lumina Home", "EverGreen Living"]
PET_BRANDS = ["PawPrime", "WildTail", "FurHarbor", "Loyal Paws", "TrailMutt", "WhiskerWorks",
              "HappyHound", "NaturePaws"]
BABY_BRANDS = ["LittleSprout", "CloudNine Baby", "TinyTrails", "Gentle Start", "Snuggle Co",
               "PureBaby", "FirstSteps"]
OFFICE_BRANDS = ["InkWell", "DeskPro", "PaperTrail", "OfficeForge", "ClipLine", "NoteCraft",
                  "QuillMark", "BriteDesk", "FilePoint", "StaplePro"]
SPORTING_BRANDS = ["PeakForm", "TrailBlaze", "IronGrit", "SwiftStride", "SummitGear", "ProCourt",
                    "ForgeFit", "Alticor Sport", "RidgeLine", "CoreMax"]
AUTO_BRANDS = ["RoadGuard", "TorqueMax", "ShineDrive", "AutoFlex", "GearTrail", "MotorSafe",
               "DriveCore", "PaveTech", "AxleWorks", "ChromeLine"]

# Five parody merchants. "brands" above are manufacturer brands sold *within* these stores,
# not the stores themselves. Which merchants are even eligible to carry a category lives in
# each category's merchant_probs below -- that's what keeps SomeFrills grocery-only etc.
MERCHANTS = {
    "mall-wart":    {"name": "Mall-Wart",    "tagline": "Everything, every day."},
    "somefrills":   {"name": "SomeFrills",   "tagline": "Groceries. No fuss."},
    "wellgreens":   {"name": "WellGreens",   "tagline": "Health, beauty, and more."},
    "circuitspree": {"name": "CircuitSpree", "tagline": "Tech for every budget."},
    "threadbarn":   {"name": "Thread Barn",  "tagline": "Wear it well."},
}

CATEGORIES = {
    "groceries": {
        "target": 3300,
        "brands": GROCERY_BRANDS,
        "merchant_probs": {"mall-wart": 0.88, "somefrills": 0.55, "wellgreens": 0.22},
        "subcats": {
            "produce": dict(target=350, price=(99, 899), bases=[
                "Honeycrisp Apples", "Gala Apples", "Granny Smith Apples", "Bananas", "Navel Oranges",
                "Seedless Grapes", "Strawberries", "Blueberries", "Avocados", "Roma Tomatoes",
                "Beefsteak Tomatoes", "Cucumbers", "Red Bell Peppers", "Yellow Onions", "Red Onions",
                "Russet Potatoes", "Sweet Potatoes", "Carrots", "Broccoli Crowns", "Cauliflower",
                "Baby Spinach", "Romaine Lettuce", "Iceberg Lettuce", "Celery", "Green Beans",
                "Zucchini", "Mushrooms", "Garlic", "Lemons", "Limes", "Mangoes", "Pineapple",
                "Watermelon", "Cantaloupe"],
                variants=["per lb", "2 lb bag", "3 lb bag", "5 lb bag", "each", "6 ct",
                          "12 oz clamshell", "bunch"]),
            "dairy-eggs": dict(target=350, price=(199, 999), bases=[
                "Whole Milk", "2% Milk", "Skim Milk", "Almond Milk", "Oat Milk", "Heavy Cream",
                "Half & Half", "Salted Butter", "Unsalted Butter", "Large Eggs", "Cage-Free Eggs",
                "Organic Eggs", "Cheddar Cheese Block", "Mozzarella Cheese Shredded",
                "Parmesan Cheese Grated", "Swiss Cheese Slices", "Cream Cheese", "Greek Yogurt",
                "Vanilla Yogurt", "Cottage Cheese", "Sour Cream", "String Cheese", "Butter Spread",
                "Egg Whites", "Kefir"],
                variants=["half gallon", "1 gallon", "quart", "8 oz", "16 oz", "32 oz", "12 ct",
                          "18 ct", "5 oz cup", "6-pack cups"]),
            "meat-seafood": dict(target=400, price=(299, 2499), bases=[
                "Boneless Chicken Breast", "Chicken Thighs", "Whole Chicken", "Ground Beef 80/20",
                "Ground Beef 93/7", "Ribeye Steak", "Sirloin Steak", "Pork Chops", "Bacon",
                "Italian Sausage", "Breakfast Sausage", "Ground Turkey", "Turkey Breast",
                "Beef Brisket", "Baby Back Ribs", "Atlantic Salmon Fillet",
                "Shrimp Peeled & Deveined", "Tilapia Fillet", "Cod Fillet", "Crab Legs",
                "Lump Crab Meat", "Deli Ham", "Deli Turkey", "Hot Dogs", "Beef Jerky"],
                variants=["1 lb", "per lb", "12 oz", "16 oz", "24 oz", "2 lb pack", "8 oz",
                          "Family Pack"]),
            "bakery": dict(target=300, price=(249, 1499), bases=[
                "Sourdough Bread Loaf", "White Sandwich Bread", "Whole Wheat Bread", "Bagels",
                "English Muffins", "Dinner Rolls", "Hamburger Buns", "Hot Dog Buns", "Croissants",
                "Baguette", "Tortillas Flour", "Tortillas Corn", "Chocolate Chip Cookies",
                "Brownies", "Blueberry Muffins", "Cinnamon Rolls", "Donuts", "Birthday Cake",
                "Pie Crust", "Pita Bread"],
                variants=["loaf", "6 ct", "8 ct", "12 ct", "dozen", "9-inch", "pack of 4"]),
            "frozen": dict(target=400, price=(299, 1299), bases=[
                "Frozen Pizza", "Frozen Waffles", "Frozen French Fries", "Frozen Mixed Vegetables",
                "Frozen Peas", "Frozen Corn", "Frozen Broccoli", "Frozen Strawberries",
                "Frozen Blueberries", "Ice Cream", "Frozen Yogurt", "Popsicles",
                "Frozen Chicken Nuggets", "Frozen Meatballs", "Frozen Shrimp", "Frozen Lasagna",
                "Frozen Burritos", "Frozen Dumplings", "Frozen Pie", "Frozen Breakfast Sandwiches",
                "Frozen Pancakes", "Frozen Garlic Bread", "Frozen Onion Rings",
                "Frozen Fish Sticks", "Frozen Edamame"],
                variants=["12 oz", "16 oz", "24 oz", "32 oz", "48 oz", "family size",
                          "single serve"]),
            "pantry": dict(target=800, price=(129, 999), bases=[
                "Spaghetti Pasta", "Penne Pasta", "Macaroni", "White Rice", "Brown Rice",
                "Jasmine Rice", "Quinoa", "Black Beans Canned", "Kidney Beans Canned",
                "Chickpeas Canned", "Diced Tomatoes Canned", "Tomato Sauce", "Tomato Paste",
                "Marinara Sauce", "Alfredo Sauce", "Salsa", "Ketchup", "Mustard", "Mayonnaise",
                "BBQ Sauce", "Soy Sauce", "Hot Sauce", "Olive Oil", "Vegetable Oil",
                "Peanut Butter", "Jelly", "Honey", "Maple Syrup", "All-Purpose Flour",
                "Granulated Sugar", "Brown Sugar", "Baking Soda", "Baking Powder",
                "Cereal Corn Flakes", "Cereal Granola", "Oatmeal", "Pancake Mix",
                "Chicken Broth", "Beef Broth", "Vegetable Broth", "Soup Chicken Noodle",
                "Soup Tomato", "Mac and Cheese Box", "Instant Ramen", "Coconut Milk Canned"],
                variants=["14 oz can", "15 oz can", "16 oz box", "24 oz jar", "32 oz bottle",
                          "5 lb bag", "2 lb bag", "single packet", "12-pack cups"]),
            "snacks": dict(target=400, price=(199, 899), bases=[
                "Potato Chips", "Tortilla Chips", "Pretzels", "Popcorn", "Cheese Crackers",
                "Graham Crackers", "Saltine Crackers", "Mixed Nuts", "Trail Mix", "Granola Bars",
                "Protein Bars", "Fruit Snacks", "Chocolate Bars",
                "Chocolate Chip Cookies Snack Pack", "Rice Cakes", "Beef Jerky Snack Pack",
                "Pita Chips", "Veggie Chips", "Cheese Puffs", "Hummus", "Guacamole",
                "Dried Fruit", "Candy Gummies", "Candy Chocolate Assorted", "Peanuts Roasted",
                "Almonds Roasted", "Cashews", "Pistachios", "Corn Nuts", "Beef Snack Sticks"],
                variants=["single serve", "8 oz bag", "12 oz bag", "16 oz bag", "party size",
                          "12-pack", "box of 10"]),
            "beverages": dict(target=300, price=(149, 2499), bases=[
                "Bottled Water", "Sparkling Water", "Cola", "Lemon-Lime Soda", "Root Beer",
                "Orange Juice", "Apple Juice", "Cranberry Juice", "Sports Drink", "Energy Drink",
                "Iced Tea", "Lemonade", "Coffee Ground", "Coffee Beans", "Instant Coffee",
                "K-Cup Pods", "Hot Cocoa Mix", "Green Tea Bags", "Black Tea Bags", "Herbal Tea",
                "Beer Variety Pack", "Red Wine", "White Wine", "Coconut Water", "Kombucha"],
                variants=["16.9 oz bottle", "2 liter", "12 oz can", "case of 24", "case of 12",
                          "1 gallon", "32 oz", "6-pack"]),
        },
    },
    "clothing": {
        "target": 1800,
        "brands": CLOTHING_BRANDS,
        "merchant_probs": {"mall-wart": 0.82, "threadbarn": 0.92},
        "is_apparel": True,
        "subcats": {
            "mens-tops": dict(target=300, price=(999, 4999), bases=[
                "Crew Neck T-Shirt", "V-Neck T-Shirt", "Polo Shirt", "Henley Shirt",
                "Flannel Button-Down", "Oxford Dress Shirt", "Graphic Tee", "Long Sleeve Thermal",
                "Tank Top", "Hooded Sweatshirt", "Crewneck Sweatshirt", "Quarter-Zip Pullover"],
                sizes=["S", "M", "L", "XL", "XXL"],
                colors=["Black", "White", "Navy", "Heather Gray", "Olive", "Maroon",
                        "Royal Blue", "Charcoal", "Khaki", "Forest Green"]),
            "mens-bottoms": dict(target=250, price=(1999, 6999), bases=[
                "Slim Fit Jeans", "Relaxed Fit Jeans", "Straight Leg Jeans", "Chino Pants",
                "Cargo Shorts", "Athletic Shorts", "Sweatpants", "Joggers", "Dress Pants",
                "Corduroy Pants"],
                sizes=["30x30", "32x30", "32x32", "34x32", "34x34", "36x32", "38x34", "40x34"],
                colors=["Indigo", "Black", "Khaki", "Charcoal", "Olive", "Light Wash", "Dark Wash"]),
            "womens-tops": dict(target=300, price=(1299, 5999), bases=[
                "Fitted Crew Tee", "Flowy Blouse", "Button-Down Shirt", "Wrap Top", "Tank Top",
                "Cardigan", "Pullover Sweater", "Turtleneck", "Crop Top", "Tunic",
                "Off-Shoulder Top"],
                sizes=["XS", "S", "M", "L", "XL", "XXL"],
                colors=["Black", "White", "Blush", "Ivory", "Navy", "Emerald", "Dusty Rose",
                        "Mustard", "Lavender", "Charcoal"]),
            "womens-bottoms": dict(target=250, price=(1999, 6999), bases=[
                "Skinny Jeans", "Straight Leg Jeans", "Bootcut Jeans", "Wide Leg Trousers",
                "Leggings", "Joggers", "Pencil Skirt", "A-Line Skirt", "Denim Shorts",
                "Yoga Pants"],
                sizes=["0", "2", "4", "6", "8", "10", "12", "14"],
                colors=["Black", "Indigo", "Light Wash", "Dark Wash", "Olive", "Charcoal", "Blush"]),
            "outerwear": dict(target=300, price=(3999, 14999), bases=[
                "Puffer Jacket", "Rain Jacket", "Denim Jacket", "Bomber Jacket", "Wool Peacoat",
                "Fleece Vest", "Trench Coat", "Windbreaker", "Parka", "Quilted Vest"],
                sizes=["S", "M", "L", "XL", "XXL"],
                colors=["Black", "Navy", "Olive", "Charcoal", "Camel", "Burgundy"]),
            "footwear": dict(target=250, price=(2499, 12999), bases=[
                "Running Shoes", "Canvas Sneakers", "Leather Boots", "Hiking Boots",
                "Slip-On Loafers", "Sandals", "Flip Flops", "Ankle Boots", "Dress Shoes",
                "Rain Boots", "High-Top Sneakers", "Slides"],
                sizes=["6", "7", "8", "9", "10", "11", "12", "13"],
                colors=["Black", "White", "Brown", "Tan", "Gray", "Navy"]),
            "accessories": dict(target=150, price=(999, 7999), bases=[
                "Leather Belt", "Canvas Belt", "Baseball Cap", "Beanie", "Wool Scarf",
                "Knit Gloves", "Crew Socks (3-Pack)", "Ankle Socks (6-Pack)", "Tote Bag",
                "Backpack", "Sunglasses", "Wallet"],
                sizes=["One Size"],
                colors=["Black", "Brown", "Navy", "Gray", "Tan", "Olive"]),
        },
    },
    "toiletries": {
        "target": 1100,
        "brands": TOILETRY_BRANDS,
        "merchant_probs": {"mall-wart": 0.80, "wellgreens": 0.90},
        "subcats": {
            "oral-care": dict(target=200, price=(199, 1299), bases=[
                "Whitening Toothpaste", "Sensitive Toothpaste", "Kids Toothpaste",
                "Electric Toothbrush Head Refill", "Manual Toothbrush Soft",
                "Manual Toothbrush Medium", "Dental Floss", "Floss Picks",
                "Mouthwash Antiseptic", "Mouthwash Alcohol-Free", "Teeth Whitening Strips",
                "Denture Cleaner Tablets"],
                variants=["3 oz", "4.2 oz", "6 oz", "8.2 oz", "single", "2-pack", "pack of 4",
                          "500 mL"]),
            "hair-care": dict(target=250, price=(399, 1999), bases=[
                "Daily Shampoo", "Moisturizing Shampoo", "Anti-Dandruff Shampoo",
                "Volumizing Shampoo", "Conditioner", "Deep Conditioning Mask",
                "Leave-In Conditioner", "Hair Gel", "Hair Mousse", "Hair Spray", "Dry Shampoo",
                "Hair Serum", "Curl Cream", "Detangling Spray", "Hair Oil Treatment"],
                variants=["8 oz", "12 oz", "16 oz", "25.4 oz", "3.4 oz travel size"]),
            "skin-care": dict(target=250, price=(299, 2999), bases=[
                "Daily Facial Moisturizer", "Night Cream", "Facial Cleanser Gel",
                "Facial Cleanser Foam", "Micellar Water", "Exfoliating Scrub",
                "Face Serum Vitamin C", "Face Serum Hyaluronic Acid", "Eye Cream",
                "Sunscreen SPF 30", "Sunscreen SPF 50", "Body Lotion", "Hand Cream", "Lip Balm",
                "Acne Treatment Gel", "Face Mask Sheet", "Makeup Remover Wipes"],
                variants=["1.7 oz", "2 oz", "3 oz", "4 oz", "6.7 oz", "8 oz", "single packet"]),
            "bath-body": dict(target=250, price=(149, 1499), bases=[
                "Bar Soap", "Body Wash", "Foaming Hand Soap", "Bath Bomb", "Shower Gel", "Loofah",
                "Body Scrub", "Antiperspirant Deodorant", "Deodorant Spray", "Talc-Free Powder",
                "Baby Wipes Sensitive", "Hand Sanitizer Gel", "Hand Sanitizer Spray"],
                variants=["3 oz bar", "8 oz", "12 oz", "16 oz", "2-pack", "3-pack", "travel size"]),
            "health-firstaid": dict(target=150, price=(299, 2499), bases=[
                "Pain Reliever Tablets", "Allergy Relief Tablets", "Cold & Flu Relief",
                "Cough Drops", "Adhesive Bandages", "Antibiotic Ointment", "Hydrogen Peroxide",
                "Rubbing Alcohol", "Digital Thermometer", "Reading Glasses",
                "Multivitamin Tablets", "Vitamin C Gummies", "Vitamin D Softgels",
                "Fiber Supplement", "Antacid Tablets", "Disposable Razors", "Shaving Cream",
                "Feminine Pads", "Tampons", "Menstrual Cup"],
                variants=["24 ct", "50 ct", "100 ct", "8 oz", "16 oz", "single", "box of 20",
                          "4-pack"]),
        },
    },
    "electronics": {
        "target": 900,
        "brands": ELECTRONICS_BRANDS,
        "merchant_probs": {"mall-wart": 0.75, "circuitspree": 0.93},
        "subcats": {
            "phones-accessories": dict(target=150, price=(999, 5999), bases=[
                "Phone Case", "Screen Protector Glass", "Wireless Car Charger Mount",
                "Phone Ring Holder", "Portable Power Bank 10000mAh",
                "Portable Power Bank 20000mAh", "Bluetooth Earpiece", "Phone Stand",
                "PopSocket Grip", "Waterproof Phone Pouch"],
                variants=["Universal", "iPhone-Compatible", "Android-Compatible", "5-inch",
                          "6.1-inch", "6.7-inch"]),
            "computers-tablets": dict(target=150, price=(1499, 8999), bases=[
                "Wireless Mouse", "Wired Mouse", "Mechanical Keyboard", "Membrane Keyboard",
                "USB Webcam 1080p", "USB Webcam 4K", "Laptop Sleeve 13-inch",
                "Laptop Sleeve 15-inch", "Laptop Stand", "External SSD 500GB",
                "External SSD 1TB", "External HDD 2TB", "USB Flash Drive 64GB",
                "USB Flash Drive 128GB", "Tablet Stylus Pen", "Tablet Screen Protector",
                "Tablet Case"],
                variants=["Black", "White", "Gray", "Space Gray"]),
            "audio": dict(target=150, price=(1999, 19999), bases=[
                "Wireless Earbuds", "Over-Ear Headphones", "On-Ear Headphones",
                "Noise Cancelling Headphones", "Bluetooth Speaker Mini",
                "Bluetooth Speaker Portable", "Soundbar", "Wired Earphones", "Gaming Headset",
                "Karaoke Microphone"],
                variants=["Black", "White", "Blue", "Red"]),
            "tv-home-theater": dict(target=100, price=(2999, 69999), bases=[
                "32-inch LED TV", "43-inch Smart TV", "50-inch 4K TV", "55-inch 4K TV",
                "65-inch 4K TV", "HDMI Soundbar", "TV Wall Mount", "Streaming Media Stick",
                "Universal Remote Control", "75-inch 4K TV", "Home Theater Projector",
                "Surround Sound Speaker System"],
                variants=["Standard Model", "New Release"]),
            "gaming": dict(target=150, price=(1499, 29999), bases=[
                "Wireless Game Controller", "Wired Game Controller", "Gaming Mouse",
                "Gaming Mouse Pad", "Gaming Chair", "Gaming Headset Mic",
                "Game Console Charging Dock", "Memory Card 256GB", "Game Storage Case",
                "VR Headset Lens Cover"],
                variants=["Black", "Camo", "RGB"]),
            "cables-smart-home": dict(target=200, price=(699, 14999), bases=[
                "USB-C Cable 6ft", "Lightning Cable 6ft", "HDMI Cable 10ft", "Wall Charger 20W",
                "Wall Charger Dual Port", "Surge Protector Power Strip", "Extension Cord 15ft",
                "Smart Plug", "Smart Light Bulb", "Smart Doorbell Camera", "Smart Thermostat",
                "Motion Sensor Light", "WiFi Range Extender", "Ethernet Cable 25ft"],
                variants=["Standard", "2-pack", "3-pack"]),
        },
    },
    "home": {
        "target": 900,
        "brands": HOME_BRANDS,
        "merchant_probs": {"mall-wart": 0.85, "circuitspree": 0.30, "threadbarn": 0.25},
        "subcats": {
            "kitchen-dining": dict(target=200, price=(599, 9999), bases=[
                "Non-Stick Frying Pan", "Stainless Steel Saucepan", "Dutch Oven", "Baking Sheet",
                "Mixing Bowl Set", "Cutlery Knife Set", "Cutting Board", "Dinner Plate Set",
                "Drinking Glass Set", "Coffee Mug", "Travel Tumbler", "Food Storage Containers",
                "Can Opener", "Measuring Cup Set", "Kitchen Towels Set", "Oven Mitts", "Trivet",
                "Colander", "Salad Spinner", "Wine Glass Set"],
                variants=["Standard", "2-piece", "4-piece", "6-piece", "8-piece", "12-piece"]),
            "bedding-bath": dict(target=200, price=(999, 14999), bases=[
                "Bath Towel", "Hand Towel", "Washcloth", "Towel Set", "Bed Sheet Set Queen",
                "Bed Sheet Set King", "Comforter Queen", "Comforter King", "Pillow Standard",
                "Pillow King", "Mattress Pad Queen", "Shower Curtain", "Bath Mat",
                "Blanket Throw", "Duvet Cover"],
                variants=["Twin", "Full", "Queen", "King", "Standard"]),
            "decor": dict(target=150, price=(999, 14999), bases=[
                "Throw Pillow Cover", "Area Rug 5x7", "Area Rug 8x10", "Wall Art Canvas",
                "Picture Frame", "Table Lamp", "Floor Lamp", "Decorative Vase", "Candle Scented",
                "Wall Clock", "Curtain Panel Set", "Artificial Plant", "Mirror Round"],
                variants=["Natural Finish", "Black Finish", "White Finish", "Gray Finish"]),
            "cleaning-supplies": dict(target=150, price=(299, 2999), bases=[
                "All-Purpose Cleaner Spray", "Glass Cleaner", "Disinfecting Wipes",
                "Laundry Detergent", "Fabric Softener", "Dish Soap", "Dishwasher Pods",
                "Trash Bags Kitchen", "Trash Bags Lawn", "Paper Towels", "Toilet Paper",
                "Sponges", "Microfiber Cloths", "Broom", "Mop", "Vacuum Bags",
                "Air Freshener Spray"],
                variants=["Single", "2-pack", "3-pack", "12-roll", "24-pack", "32 oz", "64 oz",
                          "128 oz"]),
            "storage-organization": dict(target=100, price=(999, 7999), bases=[
                "Storage Bin Plastic", "Storage Bin Fabric", "Closet Organizer", "Hanger Set",
                "Under-Bed Storage Box", "Shelving Unit", "Drawer Organizer", "Laundry Hamper",
                "Shoe Rack", "Over-the-Door Organizer"],
                variants=["Small", "Medium", "Large", "Set of 6", "Set of 10"]),
            "small-appliances": dict(target=100, price=(1999, 19999), bases=[
                "Coffee Maker Drip", "Single Serve Coffee Maker", "Electric Kettle",
                "Toaster 2-Slice", "Toaster 4-Slice", "Toaster Oven", "Blender", "Hand Mixer",
                "Stand Mixer", "Air Fryer", "Slow Cooker", "Rice Cooker",
                "Microwave Countertop", "Vacuum Cleaner Upright", "Vacuum Cleaner Handheld",
                "Iron Steam", "Humidifier", "Space Heater"],
                variants=["Standard", "Compact"]),
        },
    },
    "pet": {
        "target": 500,
        "brands": PET_BRANDS,
        "merchant_probs": {"mall-wart": 0.85},
        "subcats": {
            "dog": dict(target=150, price=(499, 8999), bases=[
                "Dry Dog Food Chicken", "Dry Dog Food Beef", "Dry Dog Food Puppy",
                "Wet Dog Food Can", "Dog Treats", "Dental Chews", "Dog Leash", "Dog Collar",
                "Dog Harness", "Dog Bed", "Dog Crate", "Chew Toy", "Squeaky Toy", "Dog Bowl",
                "Dog Waste Bags", "Dog Shampoo", "Dog Sweater"],
                variants=["Small", "Medium", "Large", "5 lb", "15 lb", "30 lb"]),
            "cat": dict(target=150, price=(399, 7999), bases=[
                "Dry Cat Food Chicken", "Dry Cat Food Salmon", "Wet Cat Food Can", "Cat Treats",
                "Cat Litter Clumping", "Cat Litter Non-Clumping", "Litter Box", "Litter Scoop",
                "Scratching Post", "Cat Toy Wand", "Cat Bed", "Cat Collar", "Cat Carrier",
                "Cat Brush"],
                variants=["Small", "Medium", "Large", "7 lb", "15 lb", "25 lb"]),
            "small-animal-fish": dict(target=100, price=(699, 9999), bases=[
                "Fish Tank 10 Gallon", "Fish Tank Filter", "Fish Food Flakes", "Aquarium Gravel",
                "Aquarium Decoration", "Betta Fish Bowl", "Hamster Cage", "Hamster Bedding",
                "Hamster Food", "Guinea Pig Food", "Bird Cage", "Bird Seed Mix",
                "Reptile Terrarium", "Reptile Heat Lamp"],
                variants=["Standard", "Small", "Large"]),
            "grooming-accessories": dict(target=100, price=(599, 5999), bases=[
                "Pet Nail Clipper", "Pet Shampoo", "Pet Brush Slicker", "Pet Toothbrush Kit",
                "Flea & Tick Treatment", "Pet Odor Eliminator Spray", "Pet Stain Remover",
                "Pet Carrier Bag", "Pet Car Seat Cover", "Pet Gate"],
                variants=["Standard", "Travel Size"]),
        },
    },
    "baby": {
        "target": 400,
        "brands": BABY_BRANDS,
        "merchant_probs": {"mall-wart": 0.80, "wellgreens": 0.45},
        "subcats": {
            "diapers-wipes": dict(target=100, price=(699, 3499), bases=[
                "Diapers Size 1", "Diapers Size 2", "Diapers Size 3", "Diapers Size 4",
                "Diapers Size 5", "Diapers Size 6", "Baby Wipes Sensitive", "Baby Wipes Scented",
                "Training Pants", "Swim Diapers", "Diaper Rash Cream", "Diaper Pail Refill"],
                variants=["24 ct", "36 ct", "56 ct", "84 ct", "Jumbo Pack", "160-count wipes"]),
            "feeding": dict(target=100, price=(499, 9999), bases=[
                "Infant Formula Powder", "Toddler Formula", "Baby Food Pouch Fruit",
                "Baby Food Pouch Vegetable", "Baby Food Jar", "Infant Cereal Rice",
                "Infant Cereal Oatmeal", "Baby Bottle", "Bottle Nipples", "Sippy Cup", "Bibs",
                "Pacifier", "Burp Cloths", "Breast Milk Storage Bags", "High Chair"],
                variants=["Standard", "Stage 1", "Stage 2", "2-Pack", "4-Pack"]),
            "gear": dict(target=100, price=(1999, 29999), bases=[
                "Baby Stroller", "Car Seat Infant", "Car Seat Convertible", "Baby Carrier Wrap",
                "Baby Monitor Video", "Playard Portable Crib", "Baby Swing", "Bouncer Seat",
                "Diaper Bag", "Baby Gate", "Changing Pad", "Baby Bathtub"],
                variants=["Standard", "Deluxe"]),
            "toys": dict(target=100, price=(699, 5999), bases=[
                "Stacking Rings Toy", "Soft Building Blocks", "Plush Teddy Bear", "Rattle Toy",
                "Teething Toy", "Activity Gym Mat", "Push Walker Toy", "Shape Sorter",
                "Baby Mirror Toy", "Musical Toy", "Board Book Set"],
                variants=["Standard", "Multicolor Edition"]),
        },
    },
    "office": {
        "target": 300,
        "brands": OFFICE_BRANDS,
        "merchant_probs": {"mall-wart": 0.75, "circuitspree": 0.45},
        "subcats": {
            "writing": dict(target=75, price=(199, 1499), bases=[
                "Ballpoint Pens (12-pack)", "Gel Pens (8-pack)", "Permanent Markers (4-pack)",
                "Highlighters (6-pack)", "Mechanical Pencils (10-pack)",
                "Wooden Pencils (24-pack)", "Dry Erase Markers (4-pack)",
                "Colored Pencils (24-pack)", "Fine Point Markers", "Correction Tape"],
                variants=["Standard"]),
            "paper": dict(target=75, price=(299, 2499), bases=[
                "Copy Paper Ream", "Legal Pads (3-pack)", "Sticky Notes (12-pack)",
                "Index Cards (300 ct)", "Notebook Spiral", "Composition Notebook",
                "Graph Paper Pad", "Printer Photo Paper", "Construction Paper Pack",
                "Cardstock Pack"],
                variants=["Standard"]),
            "desk-accessories": dict(target=75, price=(399, 3999), bases=[
                "Desk Organizer Tray", "Pen Cup Holder", "Stapler", "Staple Remover",
                "Tape Dispenser", "Scissors", "Paper Clips Box", "Binder Clips Set",
                "Rubber Bands Bag", "Desk Lamp", "Mouse Pad", "Letter Tray", "Bulletin Board",
                "Whiteboard Small"],
                variants=["Standard"]),
            "filing-printer": dict(target=75, price=(499, 8999), bases=[
                "Manila Folders (100-pack)", "Hanging File Folders (25-pack)",
                "3-Ring Binder 1-inch", "3-Ring Binder 2-inch", "Expanding File Organizer",
                "Label Maker Tape", "Printer Ink Black Cartridge", "Printer Ink Color Cartridge",
                "Toner Cartridge", "Shredder Cross-Cut", "Laminating Sheets"],
                variants=["Standard"]),
        },
    },
    "sporting": {
        "target": 500,
        "brands": SPORTING_BRANDS,
        "merchant_probs": {"mall-wart": 0.85},
        "subcats": {
            "fitness": dict(target=150, price=(999, 49999), bases=[
                "Yoga Mat", "Resistance Bands Set", "Adjustable Dumbbells", "Kettlebell",
                "Jump Rope", "Foam Roller", "Exercise Ball", "Ab Roller", "Pull-Up Bar",
                "Weight Bench", "Treadmill Compact", "Exercise Bike Stationary",
                "Yoga Block Set", "Gym Gloves", "Fitness Tracker Band"],
                variants=["Standard", "Pro Series"]),
            "team-sports": dict(target=150, price=(999, 19999), bases=[
                "Soccer Ball", "Basketball", "Football", "Baseball", "Softball", "Volleyball",
                "Soccer Goal Net", "Basketball Hoop Portable", "Baseball Glove",
                "Batting Helmet", "Shin Guards", "Soccer Cleats", "Basketball Jersey",
                "Team Water Bottle", "Sports Duffel Bag"],
                variants=["Standard", "Pro Series"]),
            "outdoor-camping": dict(target=100, price=(1499, 29999), bases=[
                "2-Person Tent", "4-Person Tent", "Sleeping Bag", "Sleeping Pad",
                "Camp Chair Folding", "Camp Stove Portable", "Cooler 24-Quart",
                "Cooler 48-Quart", "Headlamp LED", "Hiking Backpack", "Trekking Poles",
                "Hammock Camping", "Lantern LED", "Water Filter Bottle", "Multi-Tool"],
                variants=["Standard", "Pro Series"]),
            "cycling-swim": dict(target=100, price=(999, 49999), bases=[
                "Mountain Bike", "Road Bike", "Bike Helmet", "Bike Lock Cable",
                "Bike Pump Floor", "Bike Water Bottle Cage", "Swim Goggles", "Swim Cap",
                "Kickboard", "Pool Noodle", "Swim Trunks", "One-Piece Swimsuit", "Beach Towel",
                "Pool Float"],
                variants=["Standard", "Pro Series"]),
        },
    },
    "automotive": {
        "target": 300,
        "brands": AUTO_BRANDS,
        "merchant_probs": {"mall-wart": 0.85},
        "subcats": {
            "car-care": dict(target=75, price=(499, 4999), bases=[
                "Car Wash Soap", "Car Wax Paste", "Microfiber Wash Mitt", "Tire Shine Spray",
                "Glass Cleaner Automotive", "Interior Detailer Spray", "Leather Cleaner",
                "Car Vacuum Handheld", "Chamois Drying Towel", "Wheel Cleaner Spray"],
                variants=["Standard", "Travel Size"]),
            "fluids-oil": dict(target=75, price=(399, 5999), bases=[
                "Synthetic Motor Oil 5W-30", "Conventional Motor Oil 10W-30", "Oil Filter",
                "Windshield Washer Fluid", "Antifreeze Coolant", "Brake Fluid",
                "Power Steering Fluid", "Transmission Fluid", "Fuel Injector Cleaner",
                "Octane Booster"],
                variants=["Standard", "Bulk"]),
            "accessories": dict(target=75, price=(999, 14999), bases=[
                "Floor Mats All-Weather", "Seat Covers", "Steering Wheel Cover",
                "Phone Mount Dashboard", "Sun Shade Windshield", "Cargo Organizer Trunk",
                "License Plate Frame", "Car Charger USB", "Air Freshener Vent Clip", "Dash Cam"],
                variants=["Standard", "Premium"]),
            "tools": dict(target=75, price=(999, 14999), bases=[
                "Jumper Cables", "Tire Pressure Gauge", "Tire Inflator Portable",
                "Socket Wrench Set", "Jack Stand Pair", "Hydraulic Floor Jack",
                "Emergency Roadside Kit", "Funnel Set", "Spark Plug Set", "OBD2 Code Reader"],
                variants=["Standard", "Heavy Duty"]),
        },
    },
}

PRICE_ENDINGS = [99, 49, 79, 29, 95, 0]


def seeded_rng(*parts) -> random.Random:
    """Stable seed independent of PYTHONHASHSEED, so output is reproducible run-to-run."""
    key = "|".join(str(p) for p in parts).encode()
    digest = hashlib.sha256(key).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def realistic_price(rng: random.Random, lo: int, hi: int) -> int:
    lo_d, hi_d = lo // 100, max(hi // 100, lo // 100)
    dollars = rng.randint(lo_d, hi_d)
    price = dollars * 100 + rng.choice(PRICE_ENDINGS)
    return max(lo, min(hi, price))


def assign_merchants(rng: random.Random, probs: dict[str, float]) -> list[str]:
    """Independent Bernoulli trial per eligible merchant -- never a category partition.
    Falls back to the single highest-probability merchant if every trial fails, so no item
    is ever orphaned."""
    chosen = [m for m, p in probs.items() if rng.random() < p]
    if not chosen:
        chosen = [max(probs, key=probs.get)]
    return sorted(chosen)


def generate_items() -> list[dict]:
    items = []
    seq = 0
    for cat_id, cat in CATEGORIES.items():
        brands = cat["brands"]
        probs = cat["merchant_probs"]
        for sub_id, sub in cat["subcats"].items():
            rng = seeded_rng(RNG_SEED, cat_id, sub_id)
            bases = sub["bases"]
            if cat.get("is_apparel"):
                combos = list(itertools.product(brands, bases, sub["sizes"], sub["colors"]))
            else:
                combos = list(itertools.product(brands, bases, sub["variants"]))
            rng.shuffle(combos)
            for combo in combos[: sub["target"]]:
                seq += 1
                item_rng = seeded_rng(RNG_SEED, cat_id, sub_id, seq)
                price_cents = realistic_price(item_rng, *sub["price"])
                merchant_ids = assign_merchants(item_rng, probs)
                if cat.get("is_apparel"):
                    brand, base, size, color = combo
                    name = f"{brand} {base}, {size}, {color}"
                    attributes = {"size": size, "color": color}
                else:
                    brand, base, variant = combo
                    name = f"{brand} {base}, {variant}"
                    attributes = {"size": variant}
                items.append({
                    "id": f"{cat_id}-{seq:05d}",
                    "name": name,
                    "brand": brand,
                    "category": cat_id,
                    "subcategory": sub_id,
                    "priceCents": price_cents,
                    "currency": "USD",
                    "attributes": attributes,
                    "merchantIds": merchant_ids,
                })
    return items


def print_stats(items: list[dict]) -> None:
    by_merchant = Counter()
    by_merchant_cat: dict[str, Counter] = defaultdict(Counter)
    for it in items:
        for m in it["merchantIds"]:
            by_merchant[m] += 1
            by_merchant_cat[m][it["category"]] += 1

    print(f"total items: {len(items)}")
    print(f"unique ids: {len({i['id'] for i in items})}")
    print(f"orphaned items (zero merchants): {sum(1 for i in items if not i['merchantIds'])}")
    print("\nper-merchant listings and category coverage:")
    for m in MERCHANTS:
        cats = sorted(by_merchant_cat[m].keys())
        print(f"  {m:14s} {by_merchant[m]:5d} items  categories={cats}")

    groc = [i for i in items if i["category"] == "groceries"]
    mw = {i["id"] for i in groc if "mall-wart" in i["merchantIds"]}
    sf = {i["id"] for i in groc if "somefrills" in i["merchantIds"]}
    print(f"\ngroceries overlap -- mall-wart={len(mw)} somefrills={len(sf)} "
          f"both={len(mw & sf)} mall-wart-only={len(mw - sf)} somefrills-only={len(sf - mw)}")


def main() -> None:
    items = generate_items()
    print_stats(items)

    resources = Path(__file__).resolve().parents[1] / "src" / "main" / "resources"
    resources.mkdir(parents=True, exist_ok=True)

    catalog_path = resources / "catalog.json"
    catalog_path.write_text(json.dumps(items, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {len(items)} items to {catalog_path}")

    merchants_path = resources / "merchants.json"
    merchants_payload = [{"id": mid, **info} for mid, info in MERCHANTS.items()]
    merchants_path.write_text(json.dumps(merchants_payload, indent=2), encoding="utf-8")
    print(f"wrote {len(merchants_payload)} merchants to {merchants_path}")


if __name__ == "__main__":
    main()
