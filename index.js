// An extension that allows you to import characters from CHub.
// TODO: allow multiple characters to be imported at once
import {
    getRequestHeaders,
    processDroppedFiles,
    callPopup
} from "../../../../script.js";
import { debounce } from "../../../utils.js";
import { extension_settings } from "../../../extensions.js";

const extensionName = "SillyTavern-Chub-Search";

// Endpoint for API call
const API_ENDPOINT_SEARCH = "https://gateway.chub.ai/search";

const defaultSettings = {
    findCount: 10,
    nsfw: false,
};

let chubCharacters = [];
let characterListContainer = null;  // A global variable to hold the reference
let popupState = null;
let savedPopupContent = null;


/**
 * Asynchronously loads settings from `extension_settings.chub`, 
 * filling in with default settings if some are missing.
 * 
 * After loading the settings, it also updates the UI components 
 * with the appropriate values from the loaded settings.
 */
async function loadSettings() {
    // Ensure extension_settings.timeline exists
    if (!extension_settings.chub) {
        console.log("Creating extension_settings.chub");
        extension_settings.chub = {};
    }

    // Check and merge each default setting if it doesn't exist
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!extension_settings.chub.hasOwnProperty(key)) {
            console.log(`Setting default for: ${key}`);
            extension_settings.chub[key] = value;
        }
    }

}

/**
 * Downloads a custom character based on the provided fullPath.
 * @param {string} fullPath - The full path of the character from search results (e.g., "user/character-name")
 * @returns {Promise<void>} - Resolves once the character has been processed or if an error occurs.
 */
async function downloadCharacter(fullPath) {
    console.debug('Custom content import started', fullPath);
    let request = null;
    
    try {
        // Send the fullPath directly to the /importUUID endpoint
        request = await fetch('/api/content/importUUID', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ "url": fullPath }),
        });
    } catch (error) {
        console.error('Network error during character import:', error);
        toastr.error('Network error during character import');
        return;
    }

    if (!request.ok) {
        // Construct the character page URL for fallback
        const fallbackUrl = `https://www.chub.ai/characters/${fullPath}`;
        
        toastr.info("Click to go to the character page", 'Custom content import failed', {onclick: () => window.open(fallbackUrl, '_blank') });
        console.error('Custom content import failed', request.status, request.statusText);
        return;
    }

    let data;
    try {
        data = await request.blob();
    } catch (error) {
        console.error('Error reading response data:', error);
        toastr.error('Failed to process character data');
        return;
    }
    
    const customContentType = request.headers.get('X-Custom-Content-Type');
    const contentDisposition = request.headers.get('Content-Disposition');
    
    if (!contentDisposition || !contentDisposition.includes('filename=')) {
        console.error('Missing or invalid Content-Disposition header');
        toastr.error('Invalid response from server');
        return;
    }
    
    const fileName = contentDisposition.split('filename=')[1].replace(/"/g, '');
    const file = new File([data], fileName, { type: data.type });

    switch (customContentType) {
        case 'character':
            processDroppedFiles([file]);
            break;
        default:
            toastr.warning('Unknown content type');
            console.error('Unknown content type', customContentType);
            break;
    }
}

/**
 * Updates the character list in the view based on provided characters.
 * @param {Array} characters - A list of character data objects to be rendered in the view.
 */
function updateCharacterListInView(characters) {
    if (characterListContainer) {
        characterListContainer.innerHTML = characters.map(generateCharacterListItem).join('');
    }
}


/**
 * Fetches characters based on specified search criteria.
 * @param {Object} options - The search options object.
 * @param {string} [options.searchTerm] - A search term to filter characters by name/description.
 * @param {Array<string>} [options.includeTags] - A list of tags that the returned characters should include.
 * @param {Array<string>} [options.excludeTags] - A list of tags that the returned characters should not include.
 * @param {boolean} [options.nsfw] - Whether or not to include NSFW characters. Defaults to the extension settings.
 * @param {string} [options.sort] - The criteria by which to sort the characters. Default is by download count.
 * @param {number} [options.page=1] - The page number for pagination. Defaults to 1.
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function fetchCharactersBySearch({ searchTerm, includeTags, excludeTags, nsfw, sort, page=1 }) {

    let first = extension_settings.chub.findCount;
    let asc = false;
    let include_forks = true;
    nsfw = nsfw || extension_settings.chub.nsfw;  // Default to extension settings if not provided
    let require_images = false;
    let require_custom_prompt = false;
    searchTerm = searchTerm ? `search=${encodeURIComponent(searchTerm)}&` : '';
    sort = sort || 'download_count';

    // Construct the URL with the search parameters, if any
    //
    let url = `${API_ENDPOINT_SEARCH}?namespace=characters&${searchTerm}first=${first}&page=${page}&sort=${sort}&asc=${asc}&venus=true&include_forks=${include_forks}&nsfw=${nsfw}&require_images=${require_images}&require_custom_prompt=${require_custom_prompt}`;

    //truncate include and exclude tags to 100 characters
    includeTags = includeTags.filter(tag => tag.length > 0);
    if (includeTags && includeTags.length > 0) {
        includeTags = includeTags.join(',').slice(0, 100);
        url += `&tags=${encodeURIComponent(includeTags)}`;
    }
    //remove tags that contain no characters
    excludeTags = excludeTags.filter(tag => tag.length > 0);
    if (excludeTags && excludeTags.length > 0) {
        excludeTags = excludeTags.join(',').slice(0, 100);
        url += `&exclude_tags=${encodeURIComponent(excludeTags)}`;
    }

    let searchResponse;
    let searchData;
    
    try {
        searchResponse = await fetch(url);
        if (!searchResponse.ok) {
            console.error('Search request failed', searchResponse.status, searchResponse.statusText);
            toastr.error(`Search failed: ${searchResponse.statusText}`);
            return chubCharacters;
        }
        searchData = await searchResponse.json();
    } catch (error) {
        console.error('Error fetching search data:', error);
        toastr.error('Failed to search characters. Please check your connection.');
        return chubCharacters;
    }

    // Clear previous search results
    chubCharacters = [];

    // Add comprehensive validation check for searchData existence and structure
    if (!searchData) {
        console.warn('No search data received');
        return chubCharacters;
    }
    
    if (!searchData.data) {
        console.warn('Search data missing data property');
        return chubCharacters;
    }
    
    if (!searchData.data.nodes || !Array.isArray(searchData.data.nodes)) {
        console.warn('Search data missing nodes array');
        return chubCharacters;
    }
    
    if (searchData.data.nodes.length === 0) {
        console.log('No characters found in search results');
        return chubCharacters;
    }
    
    // Process characters with proper error handling
    let charactersPromises = searchData.data.nodes.map(node => getCharacter(node));
    let characterBlobs;
    
    try {
        characterBlobs = await Promise.all(charactersPromises);
    } catch (error) {
        console.error('Error fetching character avatars:', error);
        toastr.error('Failed to load some character images');
        return chubCharacters;
    }

    characterBlobs.forEach((character, i) => {
        if (!character) return; // Skip if character blob is null
        
        const node = searchData.data.nodes[i];
        if (!node) return; // Skip if node is null
        
        let imageUrl;
        try {
            imageUrl = URL.createObjectURL(character);
        } catch (error) {
            console.error('Error creating object URL for character image:', error);
            return; // Skip this character
        }
        
        // Add defensive null checks for node properties
        const fullPath = node.fullPath || '';
        const author = fullPath ? fullPath.split('/')[0] : 'Unknown';
        
        chubCharacters.push({
            url: imageUrl,
            description: node.tagline || node.description || "No description available",
            name: node.name || "Unknown Character",
            fullPath: fullPath,
            tags: Array.isArray(node.topics) ? node.topics : [],
            author: author,
            id: node.id || null,
        });
    });

    return chubCharacters;
}

/**
 * Searches for characters based on the provided options and manages the UI during the search.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @returns {Promise<Array>} - Resolves with an array of character objects that match the search criteria.
 */
async function searchCharacters(options) {
    if (characterListContainer && !document.body.contains(characterListContainer)) {
        console.log('Character list container is not in the DOM, removing reference');
        characterListContainer = null;
    }
    // grey out the character-list-popup while we're searching
    if (characterListContainer) {
        characterListContainer.classList.add('searching');
    }
    console.log('Searching for characters', options);
    const characters = await fetchCharactersBySearch(options);
    if (characterListContainer) {
        characterListContainer.classList.remove('searching');
    }

    return characters;
}

/**
 * Opens the character search popup UI.
 */
function openSearchPopup() {
    displayCharactersInListViewPopup();
}

/**
 * Executes a character search based on provided options and updates the view with the results.
 * @param {Object} options - The search criteria/options for fetching characters.
 * @returns {Promise<void>} - Resolves once the character list has been updated in the view.
 */
async function executeCharacterSearch(options) {
    let characters  = []
    characters = await searchCharacters(options);

    if (characters && characters.length > 0) {
        console.log('Updating character list');
        updateCharacterListInView(characters);
    } else {
        console.log('No characters found');
        characterListContainer.innerHTML = '<div class="no-characters-found">No characters found</div>';
    }
}


/**
 * Generates the HTML structure for a character list item.
 * @param {Object} character - The character data object with properties like url, name, description, tags, and author.
 * @param {number} index - The index of the character in the list.
 * @returns {string} - Returns an HTML string representation of the character list item.
 */
function generateCharacterListItem(character, index) {
    // Defensive checks for character properties
    const safeName = character.name || "Unknown Character";
    const safeAuthor = character.author || "Unknown";
    const safeDescription = character.description || "No description available";
    const safeTags = Array.isArray(character.tags) ? character.tags : [];
    const safeFullPath = character.fullPath || "";
    const safeId = character.id || "";
    
    return `
        <div class="character-list-item" data-index="${index}">
            <img class="thumbnail" src="${character.url}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22><rect width=%22100%22 height=%22100%22 fill=%22%23ccc%22/><text x=%2250%%22 y=%2250%%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23666%22>No Image</text></svg>'">
            <div class="info">
                
                <a href="https://chub.ai/characters/${safeFullPath}" target="_blank"><div class="name">${safeName}</a>
                <a href="https://chub.ai/users/${safeAuthor}" target="_blank">
                 <span class="author">by ${safeAuthor}</span>
                </a></div>
                <div class="description">${safeDescription}</div>
                <div class="tags">${safeTags.map(tag => `<span class="tag">${tag}</span>`).join('')}</div>
            </div>
            <div data-path="${safeFullPath}" data-id="${safeId}" class="menu_button download-btn fa-solid fa-cloud-arrow-down faSmallFontSquareFix"></div>
        </div>
    `;
}

// good ol' clamping
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/**
 * Displays a popup for character listings based on certain criteria. The popup provides a UI for 
 * character search, and presents the characters in a list view. Users can search characters by 
 * inputting search terms, including/excluding certain tags, sorting by various options, and opting 
 * for NSFW content. The function also offers image enlargement on click and handles character downloads.
 * 
 * If the popup content was previously generated and saved, it reuses that content. Otherwise, it creates 
 * a new layout using the given state or a default layout structure. 
 * 
 * This function manages multiple event listeners for user interactions such as searching, navigating 
 * between pages, and viewing larger character images.
 * 
 * @async
 * @function
 * @returns {Promise<void>} - Resolves when the popup is displayed and fully initialized.
 */
async function displayCharactersInListViewPopup() {
    if (savedPopupContent) {
        console.log('Using saved popup content');
        // Append the saved content to the popup container
        callPopup('', "text", '', { okButton: "Close", wide: true, large: true })
        .then(() => {
            savedPopupContent = document.querySelector('.list-and-search-wrapper');
        });

        document.getElementById('dialogue_popup_text').appendChild(savedPopupContent);
        characterListContainer = document.querySelector('.character-list-popup');
        return;
    }

    const readableOptions = {
        "download_count": "Download Count",
        "id": "ID",
        "rating": "Rating",
        "default": "Default",
        "rating_count": "Rating Count",
        "last_activity_at": "Last Activity",
        "trending_downloads": "Trending Downloads",
        "created_at": "Creation Date",
        "name": "Name",
        "n_tokens": "Token Count",
        "random": "Random"
    };

    // TODO: This should be a template
    const listLayout = popupState ? popupState : `
    <div class="list-and-search-wrapper" id="list-and-search-wrapper">
        <div class="character-list-popup">
            ${chubCharacters.map((character, index) => generateCharacterListItem(character, index)).join('')}
        </div>
        <hr>
        <div class="search-container">
            <div class="flex-container flex-no-wrap flex-align-center">
            <label for="characterSearchInput"><i class="fas fa-search"></i></label>
            <input type="text" id="characterSearchInput" class="text_pole flex1" placeholder="Search CHUB for characters...">
            </div>
            <div class="flex-container flex-no-wrap flex-align-center">
            <label for="includeTags"><i class="fas fa-plus-square"></i></label>
            <input type="text" id="includeTags" class="text_pole flex1" placeholder="Include tags (comma separated)">
            </div>
            <div class="flex-container">
            <label for="excludeTags"><i class="fas fa-minus-square"></i></label>
            <input type="text" id="excludeTags" class="text_pole flex1" placeholder="Exclude tags (comma separated)">
            </div>
            <div class="page-buttons flex-container flex-no-wrap flex-align-center">
                <div class="flex-container flex-no-wrap flex-align-center">
                    <button class="menu_button" id="pageDownButton"><i class="fas fa-chevron-left"></i></button>
                    <label for="pageNumber">Page:</label>
                    <input type="number" id="pageNumber" class="text_pole textarea_compact wide10pMinFit" min="1" value="1">
                    <button class="menu_button" id="pageUpButton"><i class="fas fa-chevron-right"></i></button>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                <label for="sortOrder">Sort By:</label> <!-- This is the label for sorting -->
                <select class="margin0" id="sortOrder">
                ${Object.keys(readableOptions).map(key => `<option value="${key}">${readableOptions[key]}</option>`).join('')}
                </select>
                </div>
                <div class="flex-container flex-no-wrap flex-align-center">
                    <label for="nsfwCheckbox">NSFW:</label>
                    <input type="checkbox" id="nsfwCheckbox">
                </div>
                <div class="menu_button" id="characterSearchButton">Search</div>
            </div>


        </div>
    </div>
`;

    // Call the popup with our list layout
    callPopup(listLayout, "text", '', { okButton: "Close", wide: true, large: true })
        .then(() => {
            savedPopupContent = document.querySelector('.list-and-search-wrapper');
        });

    characterListContainer = document.querySelector('.character-list-popup');   

    let clone = null;  // Store reference to the cloned image

    characterListContainer.addEventListener('click', function (event) {
        if (event.target.tagName === 'IMG' && event.target.classList.contains('thumbnail')) {
            const image = event.target;

            if (clone) {  // If clone exists, remove it
                try {
                    document.body.removeChild(clone);
                } catch (error) {
                    console.error('Error removing image clone:', error);
                }
                clone = null;
                return;  // Exit the function
            }

            const rect = image.getBoundingClientRect();

            clone = image.cloneNode(true);
            clone.style.position = 'absolute';
            clone.style.top = `${rect.top + window.scrollY}px`;
            clone.style.left = `${rect.left + window.scrollX}px`;
            clone.style.transform = 'scale(4)';  // Enlarge by 4 times
            clone.style.zIndex = 99999;  // High value to ensure it's above other elements
            clone.style.objectFit = 'contain';
            clone.style.cursor = 'pointer';

            document.body.appendChild(clone);

            // Prevent this click event from reaching the document's click listener
            event.stopPropagation();
        }
    });

    // Add event listener to remove the clone on next click anywhere
    document.addEventListener('click', function handler() {
        if (clone) {
            try {
                document.body.removeChild(clone);
            } catch (error) {
                console.error('Error removing image clone:', error);
            }
            clone = null;
        }
    });


    characterListContainer.addEventListener('click', async function (event) {
        if (event.target.classList.contains('download-btn')) {
            const fullPath = event.target.getAttribute('data-path');
            
            // Validate that fullPath exists before attempting download
            if (fullPath && fullPath !== 'null' && fullPath !== 'undefined') {
                try {
                    await downloadCharacter(fullPath);
                } catch (error) {
                    console.error('Error downloading character:', error);
                    toastr.error('Failed to download character');
                }
            } else {
                console.error('No character path available for download');
                toastr.error('Cannot download character - missing path information');
            }
        }
    });

    const executeCharacterSearchDebounced = debounce((options) => executeCharacterSearch(options), 750);

    // Combine the 'keydown' and 'click' event listeners for search functionality, debounce the inputs
    const handleSearch = async function (e) {
        console.log('handleSearch', e);
        if (e.type === 'keydown' && e.key !== 'Enter' && e.target.id !== 'includeTags' && e.target.id !== 'excludeTags') {
            return;
        }

        const splitAndTrim = (str) => {
            str = str.trim(); // Trim the entire string first
            if (!str.includes(',')) {
                return [str];
            }
            return str.split(',').map(tag => tag.trim());
        };

        console.log(document.getElementById('includeTags').value);

        const searchTerm = document.getElementById('characterSearchInput').value;
        const includeTags = splitAndTrim(document.getElementById('includeTags').value);
        const excludeTags = splitAndTrim(document.getElementById('excludeTags').value);
        const nsfw = document.getElementById('nsfwCheckbox').checked;
        const sort = document.getElementById('sortOrder').value;
        let page = document.getElementById('pageNumber').value;

        // If the page number is not being changed, use page 1
        if (e.target.id !== 'pageNumber' && e.target.id !== 'pageUpButton' && e.target.id !== 'pageDownButton') {
            // this is frustrating
            
            // page = 1;
            // set page box to 1
            // document.getElementById('pageNumber').value = 1;
        }

        // if page below 0, set to 1
        if (page < 1) {
            page = 1;
            document.getElementById('pageNumber').value = 1;
        }
        
        executeCharacterSearchDebounced({
            searchTerm,
            includeTags,
            excludeTags,
            nsfw,
            sort,
            page
        });
    };

    // debounce the inputs
    document.getElementById('characterSearchInput').addEventListener('change', handleSearch);
    document.getElementById('characterSearchButton').addEventListener('click', handleSearch);
    document.getElementById('includeTags').addEventListener('keyup', handleSearch);
    document.getElementById('excludeTags').addEventListener('keyup', handleSearch);
    document.getElementById('sortOrder').addEventListener('change', handleSearch);
    document.getElementById('nsfwCheckbox').addEventListener('change', handleSearch);

    // when the page number is finished being changed, search again
    document.getElementById('pageNumber').addEventListener('change', handleSearch);
    // on page up or down, update the page number, don't go below 1
    document.getElementById('pageUpButton').addEventListener('click', function (e) {
        let pageNumber = document.getElementById('pageNumber'); 

        pageNumber.value = clamp(parseInt(pageNumber.value) + 1, 0, Number.MAX_SAFE_INTEGER);
        //pageNumber.value = Math.max(1, pageNumber.value);
        
        handleSearch(e);
    }
    );
    document.getElementById('pageDownButton').addEventListener('click', function (e) {
        let pageNumber = document.getElementById('pageNumber');
        pageNumber.value = clamp(parseInt(pageNumber.value) - 1, 0, Number.MAX_SAFE_INTEGER);
        //pageNumber.value = Math.max(1, pageNumber.value);
        
        handleSearch(e);
    }
    );
}

/**
 * Fetches a character by making an API call.
 * 
 * This function sends a POST request to the API_ENDPOINT_DOWNLOAD with a provided character's fullPath. 
 * It requests the character in the "tavern" format and the "main" version. Once the data is fetched, it 
 * is converted to a blob before being returned.
 * 
 * @async
 * @function
 * @param {string} fullPath - The unique path/reference for the character to be fetched.
 * @returns {Promise<Blob>} - Resolves with a Blob of the fetched character data.
 */
async function getCharacter(node) {
    // Add proper error handling for missing required fields
    if (!node) {
        console.error('Invalid node data - node is null or undefined');
        return null;
    }
    
    if (!node.fullPath) {
        console.error('Invalid node data - missing fullPath', node);
        return null;
    }
    
    // URL-encode the fullPath when constructing avatar URLs to handle special characters
    const encodedFullPath = encodeURIComponent(node.fullPath);
    
    // Use the avatar_url from the node if available, otherwise construct it
    // Note: Removed outdated API endpoint fallback
    const avatarUrl = node.avatar_url || `https://avatars.charhub.io/avatars/${encodedFullPath}/avatar.webp`;
    
    try {
        const response = await fetch(
            avatarUrl,
            {
                method: "GET",
                headers: {
                    'Accept': 'image/*'
                },
            }
        );

        if (!response.ok) {
            console.error(`Failed to fetch avatar for ${node.fullPath}:`, response.status, response.statusText);
            // Try to return a placeholder or null
            return null;
        }
        
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            console.error(`Invalid content type for avatar: ${contentType}`);
            return null;
        }
        
        const data = await response.blob();
        return data;
    } catch (error) {
        console.error(`Error fetching character avatar for ${node.fullPath}:`, error);
        // Network errors, timeouts, etc.
        return null;
    }
}

/**
 * jQuery document-ready block:
 * - Fetches the HTML settings for an extension from a known endpoint and prepares a button for character search.
 * - The button, when clicked, triggers the `openSearchPopup` function.
 * - Finally, it loads any previously saved settings related to this extension.
 */
jQuery(async () => {
    // put our button in between external_import_button and rm_button_group_chats in the form_character_search_form
    // on hover, should say "Search CHub for characters"
    $("#external_import_button").after('<button id="search-chub" class="menu_button fa-solid fa-cloud-bolt faSmallFontSquareFix" title="Search CHub for characters"></button>');
    $("#search-chub").on("click", function () {
        openSearchPopup();
    });

    loadSettings();
});
